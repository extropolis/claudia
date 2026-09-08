import { app, BrowserWindow, ipcMain, dialog, Menu, clipboard } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { startServer, stopServer, findRunningBackend, resolveBackend, ServerInfo } from './server-manager.js';
import { initUpdater, disposeUpdater } from './updater.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let serverInfo: ServerInfo | null = null;

const isDev = process.env.NODE_ENV === 'development';

// Redirect console output to log file + DevTools console
// Buffer early logs until the window is ready, then flush them
const logBuffer: Array<{ level: string; msg: string }> = [];
let windowReady = false;
{
    const logDir = !isDev ? join(app.getPath('userData'), 'logs') : null;
    if (logDir) mkdirSync(logDir, { recursive: true });
    const logFile = logDir ? join(logDir, 'main.log') : null;
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    const formatArgs = (args: unknown[]) => args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const sendToRenderer = (level: string, msg: string) => {
        try { mainWindow?.webContents?.executeJavaScript(`console.${level}('[Backend]', ${JSON.stringify(msg)})`); } catch {}
    };
    const forwardToRenderer = (level: string, args: unknown[]) => {
        const msg = formatArgs(args);
        if (logFile) {
            try { appendFileSync(logFile, `[${new Date().toISOString()}] [${level.toUpperCase()}] ${msg}\n`); } catch {}
        }
        if (windowReady && mainWindow) {
            sendToRenderer(level, msg);
        } else {
            logBuffer.push({ level, msg });
        }
    };
    console.log = (...args: unknown[]) => { origLog(...args); forwardToRenderer('log', args); };
    console.error = (...args: unknown[]) => { origError(...args); forwardToRenderer('error', args); };
    console.warn = (...args: unknown[]) => { origWarn(...args); forwardToRenderer('warn', args); };
    // Export flush function for use after window creation
    (globalThis as any).__flushLogBuffer = () => {
        windowReady = true;
        for (const entry of logBuffer) {
            sendToRenderer(entry.level, entry.msg);
        }
        logBuffer.length = 0;
    };
    if (logFile) console.log(`Log file: ${logFile}`);
}

// GUI apps on Windows/macOS don't inherit shell PATH.
// Ensure common CLI tool locations are included so claude.exe can be found.
const home = homedir();
const extraPaths = process.platform === 'win32'
    ? [join(home, '.local', 'bin'), join(home, 'AppData', 'Roaming', 'npm')]
    : [join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), '/usr/local/bin'];
const sep = process.platform === 'win32' ? ';' : ':';
const originalPath = process.env.PATH || '';
process.env.PATH = [...extraPaths, originalPath].join(sep);
console.log(`[Main] Original PATH length: ${originalPath.length}, extra paths: ${extraPaths.join(', ')}`);

// Set the app name for menu
app.setName('Claudia');

// Build application menu with standard Edit shortcuts (Cut/Copy/Paste/SelectAll).
// Without this, Ctrl+V and other edit shortcuts don't reach the renderer in Electron.
const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
        label: app.name,
        submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'quit' as const }
        ]
    }] : []),
    {
        label: 'Edit',
        submenu: [
            { role: 'undo' as const },
            { role: 'redo' as const },
            { type: 'separator' as const },
            { role: 'cut' as const },
            { role: 'copy' as const },
            { role: 'paste' as const },
            { role: 'selectAll' as const }
        ]
    },
    {
        label: 'View',
        submenu: [
            { role: 'reload' as const },
            { role: 'toggleDevTools' as const },
            { type: 'separator' as const },
            { role: 'zoomIn' as const },
            { role: 'zoomOut' as const },
            { role: 'resetZoom' as const },
            { type: 'separator' as const },
            { role: 'togglefullscreen' as const }
        ]
    }
];
Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

/**
 * Ask the backend for the API token.
 *
 * Every /api route and every WebSocket upgrade requires one now (see
 * backend/src/auth-token.ts). Electron asks the backend over loopback rather
 * than reading the token file directly: `GET /api/auth/local` is gated on the
 * socket peer, which Electron always satisfies, and it is the same code path
 * whether Electron spawned this backend or is attaching to one that was already
 * running (#204) — no data-directory path arithmetic in two places.
 *
 * Returns null on failure, in which case the window loads without a token and
 * the SPA shows its token gate rather than a blank app.
 */
async function fetchBackendToken(backendUrl: string): Promise<string | null> {
    try {
        const res = await fetch(`${backendUrl}/api/auth/local`);
        if (!res.ok) {
            console.warn(`[Main] Auth bootstrap refused (HTTP ${res.status})`);
            return null;
        }
        const body = await res.json() as { token?: string };
        return body?.token?.trim() || null;
    } catch (error) {
        console.warn('[Main] Auth bootstrap failed:', error);
        return null;
    }
}

async function createWindow(backendUrl: string): Promise<void> {
    // Create the browser window
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: join(__dirname, 'preload.js')
        },
        title: 'Claudia',
        backgroundColor: '#1a1a1a',
        show: true
    });

    if (process.platform === 'darwin' && app.dock) {
        app.dock.show();
    }
    mainWindow.show();
    mainWindow.focus();

    // Pass backend URL as query parameter so it's available immediately on page load,
    // plus the API token — the SPA reads ?token= before it makes its first request.
    const token = await fetchBackendToken(backendUrl);
    console.log(`[Main] API token ${token ? 'acquired' : 'NOT acquired — the app will prompt'}`);
    const urlParam = `backendUrl=${encodeURIComponent(backendUrl)}`
        + (token ? `&token=${encodeURIComponent(token)}` : '');

    // Load the app
    if (isDev) {
        // In development, load from Vite dev server
        await mainWindow.loadURL(`http://localhost:5173?${urlParam}`);
    } else {
        // In production, load from built files
        // When packaged, __dirname is /dist-electron, so we go up one level
        const indexPath = join(__dirname, '..', 'frontend', 'dist', 'index.html');
        console.log(`[Main] Loading index from: ${indexPath}`);
        await mainWindow.loadURL(`file://${indexPath}?${urlParam}`);
    }

    // On macOS the window can be pushed behind other apps after loadURL;
    // ready-to-show fires once the page is rendered, so re-raise it here.
    mainWindow.once('ready-to-show', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.moveTop();
        }
        setTimeout(() => (globalThis as any).__flushLogBuffer?.(), 500);
    });

    // Notify renderer of fullscreen state changes
    mainWindow.on('enter-full-screen', () => {
        mainWindow?.webContents.send('fullscreen-changed', true);
    });
    mainWindow.on('leave-full-screen', () => {
        mainWindow?.webContents.send('fullscreen-changed', false);
    });

    // Handle window closed
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

/**
 * Stop the backend utility process exactly once.
 *
 * Two callers race for this: the normal `before-quit` path, and the updater
 * just before it hands over to Squirrel (Electron does not await async
 * `before-quit` handlers, so the updater cannot rely on that one having
 * finished). Killing an already-dead child would reject, so guard it.
 */
let backendShutdown: Promise<void> | null = null;
function shutdownBackend(): Promise<void> {
    if (!serverInfo) return Promise.resolve();
    if (!backendShutdown) {
        backendShutdown = stopServer(serverInfo.child).catch(err => {
            console.error('Backend shutdown error:', err);
        });
    }
    return backendShutdown;
}

async function startApp(): Promise<void> {
    try {
        console.log('🔮 Starting Claudia...');

        const basePath = isDev ? undefined : app.getPath('userData');

        // Attach to a backend that is already running (the user's `./start.sh`
        // on 4001, or another Claudia window) instead of booting a second one
        // against a different data dir — that is what made the desktop app show
        // an empty Claudia while the webapp showed every workspace.
        const attachUrl = process.env.CLAUDIA_BACKEND_URL || 'http://localhost:4001';
        console.log(`   Probing for a running backend at ${attachUrl}...`);

        const { info, attached } = await resolveBackend({
            probe: () => findRunningBackend(attachUrl),
            spawn: () => {
                // Only meaningful when we own the backend: an attached one uses
                // whatever data dir its own launcher gave it.
                console.log(`   Config path: ${basePath || 'backend/ (development)'}`);
                return startServer(basePath, (level, message) => {
                    // Forward backend logs from utility process to main
                    // process console (which then forwards to DevTools via our
                    // console interceptor)
                    if (level === 'error') console.error(message);
                    else if (level === 'warn') console.warn(message);
                    else console.log(message);
                });
            }
        });
        serverInfo = info;

        if (attached) {
            const version = serverInfo.version ? ` (version ${serverInfo.version})` : '';
            console.log(`🔗 Attached to running backend at ${serverInfo.url}${version} — not spawning a local one`);
        }
        console.log(`   Backend URL: ${serverInfo.url}`);

        // Create the Electron window with backend URL
        await createWindow(serverInfo.url);

        // Wire the auto-updater. Safe on every platform: when this build can't
        // self-update (dev run, .deb, unsigned macOS, npx) it registers the IPC
        // surface so Settings can explain why, and does nothing else.
        initUpdater({
            getWindow: () => mainWindow,
            getBackendUrl: () => serverInfo?.url ?? null,
            stopBackend: shutdownBackend
        });

        console.log('✅ Claudia is ready!');
    } catch (error) {
        console.error('❌ Failed to start app:', error);
        app.quit();
    }
}

// App lifecycle events
app.whenReady().then(startApp);

app.on('window-all-closed', () => {
    // On macOS, apps typically stay open until user quits explicitly
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0 && serverInfo) {
        createWindow(serverInfo.url);
    }
});

app.on('before-quit', async () => {
    disposeUpdater();
    // Gracefully stop the backend server
    await shutdownBackend();
});

// IPC Handlers
ipcMain.handle('exit-fullscreen', () => {
    mainWindow?.setFullScreen(false);
});

// Clipboard IPC (preload can't access clipboard directly)
ipcMain.on('clipboard-read', (event) => {
    event.returnValue = clipboard.readText();
});

ipcMain.on('clipboard-write', (_event, text: string) => {
    clipboard.writeText(text);
});

// Helper to persist last browsed directory path across sessions
const lastBrowsedFile = join(app.getPath('userData'), 'last-browsed-path.txt');

function getLastBrowsedPath(): string | undefined {
    try {
        if (existsSync(lastBrowsedFile)) {
            const p = readFileSync(lastBrowsedFile, 'utf-8').trim();
            if (p && existsSync(p)) return p;
        }
    } catch {}
    return undefined;
}

function setLastBrowsedPath(p: string): void {
    try { writeFileSync(lastBrowsedFile, p, 'utf-8'); } catch {}
}

ipcMain.handle('select-directory', async () => {
    if (!mainWindow) return null;

    const defaultPath = getLastBrowsedPath();
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        ...(defaultPath ? { defaultPath } : {})
    });

    if (result.canceled) {
        return null;
    }

    const selected = result.filePaths[0] || null;
    if (selected) {
        setLastBrowsedPath(selected);
    }
    return selected;
});

// Handle errors
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error);
});
