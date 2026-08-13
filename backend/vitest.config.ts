import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

// Resolve @claudia/shared to its SOURCE, not shared/dist. Without this the
// suite tests whatever was last built — a stale dist means green tests over
// old code.
const SHARED_SRC = fileURLToPath(new URL('../shared/src/index.ts', import.meta.url));

export default defineConfig({
    resolve: {
        alias: { '@claudia/shared': SHARED_SRC },
    },
    test: {
        globals: true,
        environment: 'node',
        pool: 'vmThreads',
        include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            // HONESTY: without `all`, a file that no test ever imports is
            // simply ABSENT from the report rather than counted as 0%. The
            // headline percentage then describes only the files that happen to
            // be tested, which is how a suite covering a fraction of the
            // codebase can advertise a high number. Count every source file.
            all: true,
            include: ['src/**/*.ts'],
            exclude: [
                'node_modules/',
                'dist/',
                'plugins/**',
                'test-*.ts',
                '*.config.ts',
                '**/*.d.ts',
            ],
            // Per-file regression gate: floors set just below the coverage
            // achieved by the suite. Only the modules listed here are gated,
            // so unrelated feature work that adds new files is not blocked.
            // Raise these as coverage improves; never lower them.
            thresholds: {
                'src/validation.ts': { lines: 95 },
                'src/conversation-parser.ts': { lines: 95 },
                'src/git-utils.ts': { lines: 80 },
                'src/workspace-store.ts': { lines: 90 },
                'src/task-persistence.ts': { lines: 80 },
                'src/learnings-store.ts': { lines: 88 },
                'src/usage-reporter.ts': { lines: 100 },
                'src/worktree-reaper.ts': { lines: 100 },
                'src/utils/atomic-write.ts': { lines: 88 },
                'src/utils/schema-version.ts': { lines: 80 },
                'src/plugin-system/plugin-registry.ts': { lines: 95 },
                'src/ring-buffer.ts': { lines: 100 },
                'src/token-parser.ts': { lines: 90 },
                'src/task-state-detection.ts': { lines: 90 },
                'src/config-store.ts': { lines: 85 },
                'src/supervisor-chat.ts': { lines: 95 },
                'src/cron-scheduler.ts': { lines: 95 },
            },
        },
        testTimeout: 10000,
    },
});
