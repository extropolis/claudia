import { app, BrowserWindow, ipcMain, dialog, Menu, clipboard } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { appendFileSync, mkdirSync } from 'fs';
import { startServer, stopServer, ServerInfo } from './server-manager.js';

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

// Set the app name for macOS menu
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
        show: true // Show immediately on macOS to avoid visibility issues
    });

    if (process.platform === 'darwin' && app.dock) {
        app.dock.show();
    }
    mainWindow.show();
    mainWindow.focus();

    // Pass backend URL as query parameter so it's available immediately on page load
    const urlParam = `backendUrl=${encodeURIComponent(backendUrl)}`;

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

async function startApp(): Promise<void> {
    try {
        console.log('🔮 Starting Claudia...');

        // Start the Express backend server
        const basePath = isDev ? undefined : app.getPath('userData');
        console.log(`   Config path: ${basePath || 'backend/ (development)'}`);

        serverInfo = await startServer(basePath, (level, message) => {
            // Forward backend logs from utility process to main process console
            // (which then forwards to DevTools via our console interceptor)
            if (level === 'error') console.error(message);
            else if (level === 'warn') console.warn(message);
            else console.log(message);
        });
        console.log(`   Backend URL: ${serverInfo.url}`);

        // Create the Electron window with backend URL
        await createWindow(serverInfo.url);

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
    // Gracefully stop the backend server
    if (serverInfo) {
        await stopServer(serverInfo.child);
    }
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

ipcMain.handle('select-directory', async () => {
    if (!mainWindow) return null;

    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled) {
        return null;
    }

    return result.filePaths[0] || null;
});

// Handle errors
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error);
});
