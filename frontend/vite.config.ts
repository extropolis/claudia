import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

const backendPort = process.env.CLAUDIA_BACKEND_PORT || '4001';
const frontendPort = parseInt(process.env.CLAUDIA_FRONTEND_PORT || '5173', 10);

export default defineConfig({
    plugins: [react()],
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
    },
    base: './', // Use relative paths for Electron
    server: {
        port: frontendPort,
        proxy: {
            '/api': `http://localhost:${backendPort}`,
            '/ws': {
                target: `ws://localhost:${backendPort}`,
                ws: true,
            },
        },
    },
});
