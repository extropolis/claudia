/**
 * Versioned JSON persistence (loadVersioned / saveVersioned).
 *
 * Stores evolve their on-disk shape behind a `{ schemaVersion, data }`
 * envelope, and the migration ladder is the part with teeth: it rewrites the
 * user's file in place. Until now only the happy "already current" path had
 * coverage, so an upgrade that lost data, or a throwing migration that wiped
 * the file, would have gone unnoticed.
 *
 * Temp dirs live under homedir(), not os.tmpdir() — macOS /var is blocklisted
 * by validateWorkspacePath, and the rest of the suite follows the same rule.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadVersioned, saveVersioned } from '../utils/schema-version.js';

let dir: string;
let file: string;

beforeEach(() => {
    dir = mkdtempSync(join(homedir(), '.claudia-schemaver-test-'));
    file = join(dir, 'store.json');
});

afterEach(() => {
    vi.restoreAllMocks();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
});

const readEnvelope = () => JSON.parse(readFileSync(file, 'utf-8'));

describe('loadVersioned', () => {
    it('returns the default when the file does not exist, writing nothing', () => {
        const data = loadVersioned(file, { currentVersion: 2, defaultData: { items: [] } });

        expect(data).toEqual({ items: [] });
        expect(existsSync(file)).toBe(false);
    });

    it('returns the default when the file is corrupt rather than throwing', () => {
        writeFileSync(file, '{not json');
        vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(loadVersioned(file, { currentVersion: 1, defaultData: { items: ['fallback'] } }))
            .toEqual({ items: ['fallback'] });
    });

    it('reads a current-version envelope straight through', () => {
        saveVersioned(file, { items: ['a'] }, 3);

        expect(loadVersioned(file, { currentVersion: 3, defaultData: { items: [] } }))
            .toEqual({ items: ['a'] });
        expect(readEnvelope().schemaVersion).toBe(3);
    });

    it('migrates a legacy unversioned file up the ladder and persists the result', () => {
        // A pre-versioning file: no envelope, just the payload.
        writeFileSync(file, JSON.stringify({ items: ['x'] }));

        const data = loadVersioned<{ items: string[]; v?: number }>(file, {
            currentVersion: 2,
            defaultData: { items: [] },
            legacyLoader: (raw) => ({ ...(raw as { items: string[] }), v: 0 }),
            migrations: [
                (d) => ({ ...(d as { items: string[] }), v: 1 }),
                (d) => ({ ...(d as { items: string[] }), v: 2 }),
            ],
        });

        expect(data).toEqual({ items: ['x'], v: 2 });
        // Persisted, so the next load skips the ladder entirely.
        const envelope = readEnvelope();
        expect(envelope.schemaVersion).toBe(2);
        expect(envelope.data).toEqual({ items: ['x'], v: 2 });
    });

    it('migrates a partially-upgraded file only the remaining steps', () => {
        saveVersioned(file, { steps: [] as number[] }, 1);

        const data = loadVersioned<{ steps: number[] }>(file, {
            currentVersion: 3,
            defaultData: { steps: [] },
            migrations: [
                (d) => ({ steps: [...(d as { steps: number[] }).steps, 0] }),
                (d) => ({ steps: [...(d as { steps: number[] }).steps, 1] }),
                (d) => ({ steps: [...(d as { steps: number[] }).steps, 2] }),
            ],
        });

        // v0→v1 must NOT run again; only v1→v2 and v2→v3.
        expect(data.steps).toEqual([1, 2]);
        expect(readEnvelope().schemaVersion).toBe(3);
    });

    it('keeps what it has when a migration throws instead of losing the file', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        saveVersioned(file, { items: ['keep'] }, 0);

        const data = loadVersioned<{ items: string[]; v?: number }>(file, {
            currentVersion: 3,
            defaultData: { items: [] },
            migrations: [
                (d) => ({ ...(d as { items: string[] }), v: 1 }),
                () => { throw new Error('migration blew up'); },
                (d) => ({ ...(d as { items: string[] }), v: 3 }),
            ],
        });

        // Stops at the failure — the v1 result survives, the v3 step never ran.
        expect(data).toEqual({ items: ['keep'], v: 1 });
    });

    it('tolerates a gap in the migration ladder', () => {
        saveVersioned(file, { n: 0 }, 0);

        const data = loadVersioned<{ n: number }>(file, {
            currentVersion: 2,
            defaultData: { n: -1 },
            // No v0→v1 migration registered; only v1→v2.
            migrations: [undefined as never, (d) => ({ n: (d as { n: number }).n + 1 })],
        });

        expect(data).toEqual({ n: 1 });
        expect(readEnvelope().schemaVersion).toBe(2);
    });

    it('treats an unversioned file with no legacyLoader as the raw payload', () => {
        writeFileSync(file, JSON.stringify({ items: ['raw'] }));

        expect(loadVersioned(file, { currentVersion: 0, defaultData: { items: [] } }))
            .toEqual({ items: ['raw'] });
    });
});

describe('saveVersioned', () => {
    it('writes the envelope with the version and reads back identically', () => {
        saveVersioned(file, { a: 1, nested: { b: [1, 2] } }, 7);

        expect(readEnvelope()).toEqual({ schemaVersion: 7, data: { a: 1, nested: { b: [1, 2] } } });
    });
});
