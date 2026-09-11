import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// @claudia/shared is ESM ("type": "module") and its tsconfig uses
// moduleResolution "node", which ACCEPTS extensionless relative specifiers at
// compile time and emits them verbatim. Node's ESM resolver does not add
// extensions, so `export * from './terminal'` builds clean under tsc and runs
// clean under `tsx watch`, then crashes `node backend/dist/index.js` with
// ERR_MODULE_NOT_FOUND — the published CLI and the packaged Electron app.
//
// The dev loop never touches the emitted output, and neither does the rest of
// the suite (backend/frontend vitest alias @claudia/shared to shared/SOURCE),
// so nothing else in CI can catch this class. These tests do.

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..');
const DIST = resolve(here, '..', '..', 'dist');

/**
 * Relative specifiers from real `import`/`export ... from` statements.
 *
 * Anchored to line start so commented-out imports (`// import x from './y'`)
 * are ignored, and `[^;]*?` spans newlines so multi-line import lists — 19 of
 * them in backend/src alone — are not silently skipped. Dynamic `import(...)`
 * does not match: the `(` sits where a quote would have to be.
 */
function relativeSpecifiers(source: string): string[] {
    return [
        ...[...source.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*['"](\.[^'"]*)['"]/gm)],
        ...[...source.matchAll(/^[ \t]*import[ \t]*['"](\.[^'"]*)['"]/gm)],
    ].map((m) => m[1]);
}

function jsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return jsFiles(p);
        return e.isFile() && p.endsWith('.js') ? [p] : [];
    });
}

function tsFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return tsFiles(p);
        return e.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : [];
    });
}

describe('shared ESM specifiers', () => {
    // Source-level check: covers EVERY file in src/, not just the barrel. An
    // extensionless import added to terminal.ts or config.ts breaks the built
    // package exactly the same way, and index.ts alone would not see it.
    it('every relative specifier in src/ carries a .js extension', () => {
        const files = tsFiles(SRC);
        expect(files.length).toBeGreaterThan(0);
        for (const file of files) {
            for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
                expect(spec, `${file}: "${spec}" must end in .js for Node's ESM resolver`)
                    .toMatch(/\.js$/);
            }
        }
    });

    // The real failure mode, asserted against the real artifact — in a real
    // `node` subprocess. An in-process `await import()` would prove nothing:
    // vitest resolves it through Vite, which happily adds the extension that
    // Node refuses to add. CI builds the shared package before this suite
    // (.github/workflows/tests.yml); locally it skips on an unbuilt tree.
    it.skipIf(!existsSync(join(DIST, 'index.js')))(
        'the BUILT dist/index.js is loadable by node itself',
        () => {
            const href = pathToFileURL(join(DIST, 'index.js')).href;
            const r = spawnSync(
                process.execPath,
                ['--input-type=module', '-e', `import(${JSON.stringify(href)})`],
                { encoding: 'utf8' },
            );
            expect(r.stderr, 'node failed to load the built shared package').not.toMatch(
                /ERR_MODULE_NOT_FOUND/,
            );
            expect(r.status).toBe(0);
        },
    );

    // Guards the whole emitted graph, including modules the barrel does not
    // re-export and would therefore never load.
    it.skipIf(!existsSync(DIST))('every relative specifier in dist/ resolves on disk', () => {
        const unresolved: string[] = [];
        for (const file of jsFiles(DIST)) {
            for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
                if (!existsSync(resolve(dirname(file), spec))) {
                    unresolved.push(`${file} -> ${spec}`);
                }
            }
        }
        expect(unresolved, 'unresolvable relative specifiers in built output').toEqual([]);
    });
});
