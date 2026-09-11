import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// backend is ESM ("type": "module") and its tsconfig uses moduleResolution
// "bundler", which ACCEPTS extensionless relative specifiers and emits them
// verbatim. `tsx watch` resolves them, so the dev loop is happy while
// `node dist/index.js` — the published CLI and the packaged Electron app —
// dies with ERR_MODULE_NOT_FOUND. Nothing else in the suite loads dist/.
//
// Only STATIC specifiers are checked. A dynamic `await import(...)` fails at
// call time, not at load time, and callers here guard theirs with .catch().

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
function staticRelativeSpecifiers(source: string): string[] {
    return [
        ...[...source.matchAll(/^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*['"](\.[^'"]*)['"]/gm)],
        ...[...source.matchAll(/^[ \t]*import[ \t]*['"](\.[^'"]*)['"]/gm)],
    ].map((m) => m[1]);
}

function filesWithExt(dir: string, ext: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return filesWithExt(p, ext);
        if (!e.isFile() || !p.endsWith(ext)) return [];
        return p.endsWith('.d.ts') ? [] : [p];
    });
}

describe('backend ESM specifiers', () => {
    it('every static relative specifier in src/ carries a .js extension', () => {
        const files = filesWithExt(SRC, '.ts');
        expect(files.length).toBeGreaterThan(0);
        const offenders: string[] = [];
        for (const file of files) {
            for (const spec of staticRelativeSpecifiers(readFileSync(file, 'utf8'))) {
                if (!/\.(js|json)$/.test(spec)) offenders.push(`${file} -> ${spec}`);
            }
        }
        expect(offenders, "extensionless specifiers break `node dist/index.js`").toEqual([]);
    });

    // CI builds the backend before running this suite; locally it skips on an
    // unbuilt tree.
    it.skipIf(!existsSync(DIST))('every static relative specifier in dist/ resolves on disk', () => {
        const unresolved: string[] = [];
        for (const file of filesWithExt(DIST, '.js')) {
            for (const spec of staticRelativeSpecifiers(readFileSync(file, 'utf8'))) {
                if (!existsSync(resolve(dirname(file), spec))) {
                    unresolved.push(`${file} -> ${spec}`);
                }
            }
        }
        expect(unresolved, 'unresolvable relative specifiers in built output').toEqual([]);
    });
});
