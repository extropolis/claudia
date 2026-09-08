import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @claudia/shared is ESM ("type": "module"). Node's ESM resolver does not add
// file extensions, so `export * from './terminal'` compiles fine under tsc and
// tsx but crashes `node backend/dist/index.js` with ERR_MODULE_NOT_FOUND — the
// published CLI and the packaged Electron app. This guards the barrel file so
// the regression cannot come back unnoticed.
describe('shared ESM barrel', () => {
    it('every relative re-export in src/index.ts carries a .js extension', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(resolve(here, '..', 'index.ts'), 'utf8');
        const specifiers = [...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
        expect(specifiers.length).toBeGreaterThan(0);
        for (const spec of specifiers) {
            expect(spec, `"${spec}" must end in .js for Node's ESM resolver`).toMatch(/\.js$/);
        }
    });
});
