import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        environment: 'jsdom',
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/*.spec.ts', 'src/**/*.spec.tsx'],
        setupFiles: ['./src/test/setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            // HONESTY: without `all`, files never imported by any test are
            // simply absent from the report — the suite showed "85%" while
            // WorkspacePanel/TerminalView/useWebSocket (5000+ lines) were
            // invisible. Count everything under src/.
            all: true,
            include: ['src/**/*.{ts,tsx}'],
            exclude: [
                'node_modules/',
                'dist/',
                '**/*.d.ts',
            ],
            // Per-file regression gate: floors set just below achieved
            // coverage. Only listed modules are gated, so new UI work is
            // not blocked. Raise as coverage improves; never lower.
            thresholds: {
                'src/config/api-config.ts': { lines: 95 },
                'src/hooks/useTheme.ts': { lines: 95 },
                'src/services/filePickerService.ts': { lines: 85 },
                'src/utils/browserCapabilities.ts': { lines: 85 },
                'src/stores/taskStore.ts': { lines: 70 },
            },
        },
    },
});
