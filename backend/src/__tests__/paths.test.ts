import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { tmpdir } from 'os';
import {
    resolveDataDir,
    ensureDataDir,
    dataPath,
    historyDirFor,
    describeDataDir,
    LEGACY_DATA_DIR,
    DATA_DIR_ENV,
} from '../paths.js';

describe('paths', () => {
    const created: string[] = [];

    afterEach(() => {
        for (const dir of created.splice(0)) {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            } catch {
                // Ignore cleanup errors
            }
        }
    });

    function tempDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'claudia-paths-'));
        created.push(dir);
        return dir;
    }

    describe('resolveDataDir', () => {
        it('returns undefined when nothing is configured', () => {
            expect(resolveDataDir(undefined, {})).toBeUndefined();
        });

        it('prefers an explicit path over the environment', () => {
            const explicit = tempDir();
            const env = { [DATA_DIR_ENV]: '/from/env' };
            expect(resolveDataDir(explicit, env)).toBe(explicit);
        });

        it('falls back to the environment variable', () => {
            const fromEnv = tempDir();
            expect(resolveDataDir(undefined, { [DATA_DIR_ENV]: fromEnv })).toBe(fromEnv);
        });

        it('treats an empty or whitespace value as unset', () => {
            expect(resolveDataDir(undefined, { [DATA_DIR_ENV]: '' })).toBeUndefined();
            expect(resolveDataDir(undefined, { [DATA_DIR_ENV]: '   ' })).toBeUndefined();
            expect(resolveDataDir('', {})).toBeUndefined();
        });

        it('resolves a relative path against cwd, not the source tree', () => {
            const result = resolveDataDir(undefined, { [DATA_DIR_ENV]: './claudia-data' });

            // Anchored to the operator's shell. The bug this guards against is
            // anchoring to LEGACY_DATA_DIR instead, which would silently place a
            // container's data inside the image layer.
            expect(result).toBe(join(process.cwd(), 'claudia-data'));
            expect(result).toBe(resolve('./claudia-data'));
            expect(isAbsolute(result!)).toBe(true);
        });

        it('leaves an absolute path untouched', () => {
            expect(resolveDataDir('/srv/claudia', {})).toBe('/srv/claudia');
        });
    });

    describe('ensureDataDir', () => {
        it('creates the directory when it does not exist', () => {
            const parent = tempDir();
            const target = join(parent, 'nested', 'data');
            expect(existsSync(target)).toBe(false);

            expect(ensureDataDir(target, {})).toBe(target);
            expect(existsSync(target)).toBe(true);
        });

        it('is a no-op when unconfigured', () => {
            expect(ensureDataDir(undefined, {})).toBeUndefined();
        });

        it('tolerates an existing directory', () => {
            const dir = tempDir();
            expect(ensureDataDir(dir, {})).toBe(dir);
            expect(ensureDataDir(dir, {})).toBe(dir);
            expect(existsSync(dir)).toBe(true);
        });
    });

    describe('dataPath', () => {
        it('places state files under the configured directory', () => {
            expect(dataPath('/srv/claudia', 'tasks.json')).toBe(join('/srv/claudia', 'tasks.json'));
        });

        it('falls back to the legacy location when unconfigured', () => {
            expect(dataPath(undefined, 'config.json')).toBe(join(LEGACY_DATA_DIR, 'config.json'));
        });
    });

    describe('historyDirFor', () => {
        it('is a sibling of the state files, matching TaskSpawner.getHistoryDir()', () => {
            // TaskSpawner derives it as dirname(persistencePath) + 'task-histories'.
            // These two must agree or histories are written and read in different places.
            const dataDir = '/srv/claudia';
            const persistencePath = dataPath(dataDir, 'tasks.json');
            expect(historyDirFor(dataDir)).toBe(join('/srv/claudia', 'task-histories'));
            expect(historyDirFor(dataDir)).toBe(
                join(persistencePath, '..', 'task-histories')
            );
        });

        it('falls back to the legacy location when unconfigured', () => {
            expect(historyDirFor(undefined)).toBe(join(LEGACY_DATA_DIR, 'task-histories'));
        });
    });

    describe('describeDataDir', () => {
        it('names the configured directory', () => {
            expect(describeDataDir('/srv/claudia')).toContain('/srv/claudia');
        });

        it('flags the legacy location and names the escape hatch', () => {
            const described = describeDataDir(undefined);
            expect(described).toContain('legacy');
            expect(described).toContain(DATA_DIR_ENV);
        });
    });
});
