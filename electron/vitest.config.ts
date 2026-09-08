import { defineConfig } from 'vitest/config';

/**
 * Tests for the Electron main-process code.
 *
 * Only `updater-policy.ts` is covered here, and that is deliberate: it is the
 * pure decision layer, importing neither `electron` nor `electron-updater`, so
 * it runs in a plain Node environment with no harness. The Electron-facing
 * shell (`updater.ts`) is exercised by `npm run test:updater-sim`, which drives
 * a real Electron process against a fake update feed.
 */
export default defineConfig({
    test: {
        name: 'electron',
        environment: 'node',
        include: ['__tests__/**/*.test.ts'],
        root: __dirname,
        coverage: {
            provider: 'v8',
            include: ['updater-policy.ts'],
            reporter: ['text', 'json', 'lcov'],
            thresholds: {
                // This module is pure and fully reachable; hold it high.
                lines: 90,
                functions: 90,
                branches: 85,
                statements: 90
            }
        }
    }
});
