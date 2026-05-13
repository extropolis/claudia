/**
 * Custom dev watcher — respects autoReloadEnabled config toggle.
 * Replaces `tsx watch` so file changes can be ignored when tasks are running.
 */
import { spawn } from 'child_process';
import { watch, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(__dirname, 'config.json');
const SRC_DIR = join(__dirname, 'src');
const DEBOUNCE_MS = 300;

function isAutoReloadEnabled() {
    try {
        const raw = readFileSync(CONFIG_FILE, 'utf-8');
        const config = JSON.parse(raw);
        const data = config.data ?? config;
        return data.autoReloadEnabled !== false;
    } catch {
        return true;
    }
}

function startChild() {
    const child = spawn('npx', ['tsx', 'src/index.ts'], {
        cwd: __dirname,
        stdio: 'inherit',
        env: process.env,
        shell: process.platform === 'win32'
    });
    child.on('exit', (code, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGINT') process.exit(0);
        if (!restarting) process.exit(code ?? 1);
    });
    return child;
}

let child = startChild();
let restarting = false;
let debounceTimer = null;

function restart() {
    if (restarting) return;
    restarting = true;
    console.log('[dev-watcher] Reloading...');
    child.on('exit', () => {
        child = startChild();
        restarting = false;
    });
    child.kill('SIGTERM');
}

watch(SRC_DIR, { recursive: true }, (_event, filename) => {
    if (!filename || !filename.endsWith('.ts')) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        if (isAutoReloadEnabled()) {
            restart();
        } else {
            console.log('[dev-watcher] Auto-reload disabled, skipping restart');
        }
    }, DEBOUNCE_MS);
});

process.on('SIGTERM', () => { child.kill('SIGTERM'); });
process.on('SIGINT', () => { child.kill('SIGINT'); });

console.log('[dev-watcher] Watching src/ for changes (auto-reload toggle via settings)');
