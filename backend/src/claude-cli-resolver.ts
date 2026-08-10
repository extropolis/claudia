/**
 * How the Claude Code CLI is located for spawning.
 *
 * Lives in its own module rather than inside task-spawner.ts so it can be unit
 * tested per platform: task-spawner imports node-pty, whose native binding is
 * chosen from process.platform at module load, so a test that fakes the
 * platform and re-imports task-spawner makes node-pty load the WRONG prebuilt
 * binary and throw. Nothing here imports anything heavier than fs/path.
 */
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * On Windows, `npm install -g` creates `claude.cmd` not `claude.exe`, so
 * node-pty cannot spawn it directly. Locate the underlying entry-point via
 * APPDATA and run it directly — no PATH needed.
 *
 * The platform is read per call rather than captured at module load, so the
 * behaviour is identical in production but observable from tests.
 */
export function resolveClaudeSpawn(): { command: string; prefixArgs: string[] } {
    if (process.platform !== 'win32') return { command: 'claude', prefixArgs: [] };
    const appData = process.env['APPDATA'];
    if (appData) {
        const pkgDir = join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code');
        // Newer claude-code ships a native bin/claude.exe (no cli.js). Spawn it
        // directly so multiline args like --system-prompt are passed verbatim.
        // The cmd.exe /c claude.cmd fallback re-parses the command line and
        // corrupts long/multiline args (e.g. dropping --model after the prompt).
        const exePath = join(pkgDir, 'bin', 'claude.exe');
        if (existsSync(exePath)) {
            console.log(`[TaskSpawner] Resolved Claude CLI exe via APPDATA: ${exePath}`);
            return { command: exePath, prefixArgs: [] };
        }
        // Older layout: cli.js run via node.
        const cliPath = join(pkgDir, 'cli.js');
        if (existsSync(cliPath)) {
            console.log(`[TaskSpawner] Resolved Claude CLI via APPDATA: ${process.execPath} ${cliPath}`);
            return { command: process.execPath, prefixArgs: [cliPath] };
        }
    }
    console.warn('[TaskSpawner] APPDATA-based Claude CLI not found, falling back to cmd.exe /c claude.cmd');
    return { command: 'cmd.exe', prefixArgs: ['/c', 'claude.cmd'] };
}
