#!/usr/bin/env node

// Claudia CLI
// Usage:
//   claudia                Start the app (Electron in dev, web server in production)
//   claudia web            Start the web app (backend + frontend)
//   claudia --help         Show help

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0] || 'start';

// Detect if running from a dev clone (has source files) vs npm global install (only dist)
const isDev = existsSync(join(ROOT_DIR, 'shared', 'src', 'index.ts'));

function printHelp() {
    console.log(`
Claudia - Multi-instance Claude Code orchestrator

Usage: claudia [command]

Commands:
  start         Start the app (default)
  web           Start the web app (backend + frontend)${isDev ? '\n  build         Build all packages' : ''}
  help          Show this help

Options:
  --help, -h    Show this help
  --version     Show version

Documentation: https://github.com/extropolis/claudia
`);
}

function printVersion() {
    try {
        const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf-8'));
        console.log(`claudia v${pkg.version}`);
    } catch {
        console.log('claudia (version unknown)');
    }
}

function runScript(scriptPath, scriptArgs = []) {
    const isWindows = process.platform === 'win32';
    const ext = isWindows ? '.ps1' : '.sh';
    const script = join(ROOT_DIR, scriptPath + ext);

    if (!existsSync(script)) {
        console.error(`Script not found: ${script}`);
        process.exit(1);
    }

    let child;
    if (isWindows) {
        child = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', script, ...scriptArgs], {
            cwd: ROOT_DIR,
            stdio: 'inherit',
            env: { ...process.env }
        });
    } else {
        child = spawn('bash', [script, ...scriptArgs], {
            cwd: ROOT_DIR,
            stdio: 'inherit',
            env: { ...process.env }
        });
    }

    child.on('error', (err) => {
        console.error(`Failed to start: ${err.message}`);
        process.exit(1);
    });

    child.on('exit', (code) => {
        process.exit(code || 0);
    });

    // Forward signals to child process
    ['SIGINT', 'SIGTERM'].forEach((signal) => {
        process.on(signal, () => {
            child.kill(signal);
        });
    });
}

function runNpm(script) {
    const isWindows = process.platform === 'win32';
    const npmCmd = isWindows ? 'npm.cmd' : 'npm';

    const child = spawn(npmCmd, ['run', script], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
        env: { ...process.env }
    });

    child.on('error', (err) => {
        console.error(`Failed to run npm script: ${err.message}`);
        process.exit(1);
    });

    child.on('exit', (code) => {
        process.exit(code || 0);
    });
}

/**
 * Production mode: start the backend server directly with Node.
 * The backend serves the API + pre-built frontend static files.
 */
function runProduction() {
    const backendEntry = join(ROOT_DIR, 'backend', 'dist', 'index.js');

    if (!existsSync(backendEntry)) {
        console.error('Error: Backend not found. The package may be corrupted.');
        console.error(`Expected: ${backendEntry}`);
        process.exit(1);
    }

    console.log('Starting Claudia...');

    const child = spawn(process.execPath, [backendEntry], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
        env: {
            ...process.env,
            NODE_ENV: 'production',
        }
    });

    child.on('error', (err) => {
        console.error(`Failed to start: ${err.message}`);
        process.exit(1);
    });

    child.on('exit', (code) => {
        process.exit(code || 0);
    });

    ['SIGINT', 'SIGTERM'].forEach((signal) => {
        process.on(signal, () => {
            child.kill(signal);
        });
    });
}

switch (command) {
    case 'start':
        if (isDev) {
            runScript('start-electron');
        } else {
            runProduction();
        }
        break;

    case 'web':
        if (isDev) {
            runScript('start');
        } else {
            runProduction();
        }
        break;

    case 'build':
        if (isDev) {
            runNpm('build');
        } else {
            console.error('Build is only available in development mode.');
            process.exit(1);
        }
        break;

    case 'help':
    case '--help':
    case '-h':
        printHelp();
        break;

    case '--version':
    case '-v':
        printVersion();
        break;

    default:
        console.error(`Unknown command: ${command}`);
        console.error(`Run 'claudia --help' for usage.`);
        process.exit(1);
}
