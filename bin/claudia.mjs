#!/usr/bin/env node

// Claudia CLI
// Usage:
//   claudia                Start the web app (backend + frontend)
//   claudia electron       Start the Electron desktop app
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

function printHelp() {
    console.log(`
Claudia - Multi-instance Claude Code orchestrator

Usage: claudia [command]

Commands:
  start         Start the web app (default)
  electron      Start the Electron desktop app
  build         Build all packages
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

switch (command) {
    case 'start':
        runScript('start');
        break;

    case 'electron':
        runScript('start-electron');
        break;

    case 'build':
        runNpm('build');
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
