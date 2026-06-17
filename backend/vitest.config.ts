import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        pool: 'vmThreads',
        include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
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
                'src/usage-reporter.ts': { lines: 38 },
                'src/utils/atomic-write.ts': { lines: 88 },
                'src/utils/schema-version.ts': { lines: 80 },
                'src/plugin-system/plugin-registry.ts': { lines: 95 },
                'src/ring-buffer.ts': { lines: 100 },
                'src/token-parser.ts': { lines: 90 },
                'src/task-state-detection.ts': { lines: 90 },
                'src/config-store.ts': { lines: 85 },
            },
        },
        testTimeout: 10000,
    },
});
