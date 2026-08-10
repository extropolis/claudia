import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            // Count every source file, including ones no test imports — an
            // absent file would otherwise silently inflate the percentage.
            all: true,
            include: ['src/**/*.ts'],
            exclude: [
                'node_modules/', 'dist/', '**/*.d.ts', '*.config.ts',
                // Type-only barrel: 23 `export interface/type` declarations that
                // are erased at compile time. It can never be "covered", so
                // counting it only dilutes the number with noise.
                'src/index.ts',
            ],
            // shared/ is small and consumed by BOTH backend and frontend, so a
            // regression here breaks the whole product. Gate it hard.
            thresholds: {
                'src/terminal.ts': { lines: 95 },
            },
        },
    },
});
