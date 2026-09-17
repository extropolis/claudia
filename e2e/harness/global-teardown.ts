/**
 * Global teardown: make sure nothing survives the run.
 *
 * Playwright's webServer already kills the backend/preview process trees. This
 * sweeps up the one thing it can't know about — fake `claude` PTY children the
 * backend spawned — and removes the scratch state tree.
 *
 * Set CLAUDIA_E2E_KEEP_STATE=1 to keep ~/.claudia-e2e for post-mortem digging.
 */
import { execFileSync } from 'child_process';
import { rmSync } from 'fs';
import { join } from 'path';
import { BIN_DIR, RUN_ROOT } from './env.js';

export default function globalTeardown(): void {
    // Kill only processes whose command line contains OUR fake CLI path. This
    // can never match the developer's real claude sessions.
    if (process.platform !== 'win32') {
        try {
            execFileSync('pkill', ['-f', join(BIN_DIR, 'claude')], { stdio: 'ignore' });
            process.stdout.write('[e2e] swept leftover fake-claude processes\n');
        } catch {
            // pkill exits 1 when nothing matched — the normal, healthy case.
        }
    }

    if (process.env.CLAUDIA_E2E_KEEP_STATE === '1') {
        process.stdout.write(`[e2e] keeping state dir for inspection: ${RUN_ROOT}\n`);
        return;
    }
    rmSync(RUN_ROOT, { recursive: true, force: true });
}
