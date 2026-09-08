/**
 * Builds the real backend + frontend bundles the browser suite runs against.
 *
 * Runs synchronously at Playwright config-load time so both webServers can
 * start immediately afterwards without racing each other over `shared/dist`
 * (both backend and frontend tsc/vite depend on it).
 *
 * Skip with CLAUDIA_E2E_SKIP_BUILD=1 when iterating on specs locally.
 */
import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { BACKEND_PORT, REPO_ROOT } from './env.js';

function run(label: string, cmd: string, env: NodeJS.ProcessEnv = {}): void {
    const started = Date.now();
    process.stdout.write(`[e2e] building ${label}…\n`);
    try {
        execSync(cmd, {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
        });
    } catch (err) {
        const e = err as { stdout?: Buffer; stderr?: Buffer };
        process.stderr.write(`[e2e] build FAILED (${label}): ${cmd}\n`);
        if (e.stdout) process.stderr.write(e.stdout.toString());
        if (e.stderr) process.stderr.write(e.stderr.toString());
        throw new Error(`[e2e] ${label} build failed`);
    }
    process.stdout.write(`[e2e] built ${label} in ${Math.round((Date.now() - started) / 1000)}s\n`);
}

/**
 * Prove the built frontend bundle targets the sandboxed backend.
 *
 * getBackendPort() falls back to PORTS.BACKEND (4001) when
 * VITE_CLAUDIA_BACKEND_PORT is absent, so a bundle built by hand — or a stale
 * one reused via CLAUDIA_E2E_SKIP_BUILD — points the browser straight at the
 * developer's live instance. That is a silent, destructive failure, so we
 * refuse to run unless the port is actually baked into the bundle.
 */
function assertBundleTargetsSandbox(): void {
    const assetsDir = join(REPO_ROOT, 'frontend', 'dist', 'assets');
    if (!existsSync(assetsDir)) {
        throw new Error('[e2e] frontend/dist/assets missing — build the frontend first');
    }
    const bundles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    const hit = bundles.some((f) => readFileSync(join(assetsDir, f), 'utf8').includes(String(BACKEND_PORT)));
    if (!hit) {
        throw new Error(
            `[e2e] REFUSING TO RUN: the built frontend does not reference port ${BACKEND_PORT}, ` +
            `so it would fall back to the developer's backend on 4001. ` +
            `Rebuild with VITE_CLAUDIA_BACKEND_PORT=${BACKEND_PORT} (i.e. drop CLAUDIA_E2E_SKIP_BUILD).`,
        );
    }
}

export function buildStack(): void {
    if (process.env.CLAUDIA_E2E_SKIP_BUILD === '1') {
        process.stdout.write('[e2e] CLAUDIA_E2E_SKIP_BUILD=1 — reusing existing dist/ output\n');
        if (!existsSync(join(REPO_ROOT, 'backend', 'dist', 'index.js'))) {
            throw new Error('[e2e] skip-build requested but backend/dist/index.js does not exist');
        }
        assertBundleTargetsSandbox();
        return;
    }

    run('shared', 'npm run build -w shared');
    run('backend', 'npm run build -w backend');
    // The frontend resolves its backend URL from VITE_CLAUDIA_BACKEND_PORT at
    // build time — this is what keeps the browser off port 4001.
    run('frontend', 'npm run build -w frontend', {
        VITE_CLAUDIA_BACKEND_PORT: String(BACKEND_PORT),
    });
    assertBundleTargetsSandbox();
}
