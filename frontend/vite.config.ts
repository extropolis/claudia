import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
    plugins: [react()],
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    base: './', // Use relative paths for Electron
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:4001',
            '/ws': {
                target: 'ws://localhost:4001',
                ws: true,
            },
        },
    },
});
