import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { startServer, stopServer, ServerInfo } from './server-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let serverInfo: ServerInfo | null = null;

const isDev = process.env.NODE_ENV === 'development';

// Set the app name for macOS menu
app.setName('Claudia');

async function createWindow(): Promise<void> {
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
        show: false // Don't show until ready
    });

    // Load the app
    if (isDev) {
        // In development, load from Vite dev server
        await mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        // In production, load from built files
        // When packaged, __dirname is /dist-electron, so we go up one level
        const indexPath = join(__dirname, '..', 'frontend', 'dist', 'index.html');
        console.log(`[Main] Loading index from: ${indexPath}`);
        await mainWindow.loadFile(indexPath);
        // Open DevTools to debug
        mainWindow.webContents.openDevTools();
    }

    // Show window when ready
    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
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

        serverInfo = await startServer(basePath);
        console.log(`   Backend URL: ${serverInfo.url}`);

        // Create the Electron window
        await createWindow();

        // Send backend URL to renderer process
        if (mainWindow) {
            mainWindow.webContents.once('dom-ready', () => {
                mainWindow?.webContents.send('backend-url', serverInfo!.url);
            });
        }

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
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('before-quit', async () => {
    // Gracefully stop the backend server
    if (serverInfo) {
        await stopServer(serverInfo.server);
    }
});

// IPC Handlers
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
