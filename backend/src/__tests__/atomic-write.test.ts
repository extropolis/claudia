import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteFileSync, atomicWriteFileAsync } from '../utils/atomic-write.js';

// Node's fs/promises namespace isn't configurable in ESM, so vi.spyOn can't
// touch its `rename` export directly (throws "Cannot redefine property").
// vi.mock + vi.hoisted is the supported way to intercept it: this replaces
// `rename` everywhere it's imported from 'fs/promises' (including inside
// atomic-write.ts) with a controllable wrapper that forwards to the real
// implementation unless a test asks it to fail first.
const renameMockState = vi.hoisted(() => ({ failuresRemaining: 0, errorCode: 'EPERM' as string, calls: 0 }));
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
            renameMockState.calls++;
            if (renameMockState.failuresRemaining > 0) {
                renameMockState.failuresRemaining--;
                const err = new Error(`${renameMockState.errorCode}: simulated transient failure`) as NodeJS.ErrnoException;
                err.code = renameMockState.errorCode;
                throw err;
            }
            return actual.rename(...args);
        },
    };
});

describe('atomicWriteFileSync', () => {
    let testBaseDir: string;

    beforeEach(() => {
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
        testBaseDir = join(homedir(), '.claudia-atomic-write-test-' + uniqueId);
        mkdirSync(testBaseDir, { recursive: true });
    });

    afterEach(() => {
        try {
            rmSync(testBaseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('basic writes', () => {
        it('writes string data to a new file', () => {
            const filePath = join(testBaseDir, 'file.txt');
            atomicWriteFileSync(filePath, 'hello world');
            expect(existsSync(filePath)).toBe(true);
            expect(readFileSync(filePath, 'utf-8')).toBe('hello world');
        });

        it('writes Buffer data to a new file', () => {
            const filePath = join(testBaseDir, 'buffer.bin');
            const buf = Buffer.from([0x00, 0x01, 0x02, 0xff]);
            atomicWriteFileSync(filePath, buf);
            expect(existsSync(filePath)).toBe(true);
            const read = readFileSync(filePath);
            expect(Buffer.compare(read, buf)).toBe(0);
        });

        it('overwrites an existing file with new content', () => {
            const filePath = join(testBaseDir, 'overwrite.txt');
            writeFileSync(filePath, 'old content that is longer');
            atomicWriteFileSync(filePath, 'new');
            expect(readFileSync(filePath, 'utf-8')).toBe('new');
        });

        it('respects a custom encoding for string payloads', () => {
            const filePath = join(testBaseDir, 'encoded.txt');
            // 'hello' as base64 is 'aGVsbG8='; writing that string with base64
            // encoding decodes it to the raw bytes 'hello'.
            atomicWriteFileSync(filePath, 'aGVsbG8=', { encoding: 'base64' });
            expect(readFileSync(filePath, 'utf-8')).toBe('hello');
        });

        it('handles empty string content', () => {
            const filePath = join(testBaseDir, 'empty.txt');
            atomicWriteFileSync(filePath, '');
            expect(existsSync(filePath)).toBe(true);
            expect(readFileSync(filePath, 'utf-8')).toBe('');
        });
    });

    describe('directory creation', () => {
        it('creates missing parent directories', () => {
            const filePath = join(testBaseDir, 'nested', 'deep', 'file.txt');
            atomicWriteFileSync(filePath, 'data');
            expect(existsSync(filePath)).toBe(true);
            expect(readFileSync(filePath, 'utf-8')).toBe('data');
        });
    });

    describe('temp-file cleanup', () => {
        it('leaves no .tmp file behind after a successful write', () => {
            const filePath = join(testBaseDir, 'clean.txt');
            atomicWriteFileSync(filePath, 'content');
            const leftovers = readdirSync(testBaseDir).filter((f) => f.includes('.tmp'));
            expect(leftovers).toEqual([]);
        });

        it('cleans up the temp file and preserves the original on rename failure', () => {
            // Make the target path a directory so renameSync onto it fails.
            const filePath = join(testBaseDir, 'target');
            mkdirSync(filePath);

            expect(() => atomicWriteFileSync(filePath, 'data')).toThrow();

            // No stray .tmp files left in the dir.
            const leftovers = readdirSync(testBaseDir).filter((f) => f.includes('.tmp'));
            expect(leftovers).toEqual([]);
            // The original directory is untouched.
            expect(existsSync(filePath)).toBe(true);
        });
    });

    describe('backup option', () => {
        it('does not create a .bak file by default', () => {
            const filePath = join(testBaseDir, 'nobak.txt');
            writeFileSync(filePath, 'v1');
            atomicWriteFileSync(filePath, 'v2');
            expect(existsSync(`${filePath}.bak`)).toBe(false);
            expect(readFileSync(filePath, 'utf-8')).toBe('v2');
        });

        it('rolls the previous file to .bak when backup is enabled', () => {
            const filePath = join(testBaseDir, 'withbak.txt');
            writeFileSync(filePath, 'previous');
            atomicWriteFileSync(filePath, 'current', { backup: true });

            expect(readFileSync(filePath, 'utf-8')).toBe('current');
            expect(existsSync(`${filePath}.bak`)).toBe(true);
            expect(readFileSync(`${filePath}.bak`, 'utf-8')).toBe('previous');
        });

        it('does not create a .bak when target does not exist yet, even with backup', () => {
            const filePath = join(testBaseDir, 'fresh.txt');
            atomicWriteFileSync(filePath, 'first', { backup: true });
            expect(readFileSync(filePath, 'utf-8')).toBe('first');
            expect(existsSync(`${filePath}.bak`)).toBe(false);
        });

        it('overwrites a stale .bak on a subsequent backup write', () => {
            const filePath = join(testBaseDir, 'rolling.txt');
            writeFileSync(filePath, 'gen1');
            atomicWriteFileSync(filePath, 'gen2', { backup: true });
            atomicWriteFileSync(filePath, 'gen3', { backup: true });

            expect(readFileSync(filePath, 'utf-8')).toBe('gen3');
            // .bak should now hold the most recent previous good file (gen2).
            expect(readFileSync(`${filePath}.bak`, 'utf-8')).toBe('gen2');
        });
    });

    describe('error behavior', () => {
        it('throws when the temp file cannot be written', () => {
            // Point at a path whose parent is a file, not a directory.
            const fileAsParent = join(testBaseDir, 'iamafile');
            writeFileSync(fileAsParent, 'x');
            const filePath = join(fileAsParent, 'child.txt');
            expect(() => atomicWriteFileSync(filePath, 'data')).toThrow();
        });
    });
});

describe('atomicWriteFileAsync', () => {
    let testBaseDir: string;

    beforeEach(() => {
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
        testBaseDir = join(homedir(), '.claudia-atomic-write-async-test-' + uniqueId);
        mkdirSync(testBaseDir, { recursive: true });
    });

    afterEach(() => {
        try {
            rmSync(testBaseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            // Ignore cleanup errors
        }
    });

    it('writes string data to a new file', async () => {
        const filePath = join(testBaseDir, 'file.txt');
        await atomicWriteFileAsync(filePath, 'hello world');
        expect(readFileSync(filePath, 'utf-8')).toBe('hello world');
    });

    it('leaves no .tmp file behind after a successful write', async () => {
        const filePath = join(testBaseDir, 'clean.txt');
        await atomicWriteFileAsync(filePath, 'content');
        const leftovers = readdirSync(testBaseDir).filter((f) => f.includes('.tmp'));
        expect(leftovers).toEqual([]);
    });

    describe('backup option', () => {
        it('leaves a COPY at .bak, not a move — the target must still exist right after', async () => {
            const filePath = join(testBaseDir, 'withbak.txt');
            writeFileSync(filePath, 'previous');
            await atomicWriteFileAsync(filePath, 'current', { backup: true });

            expect(readFileSync(filePath, 'utf-8')).toBe('current');
            expect(readFileSync(`${filePath}.bak`, 'utf-8')).toBe('previous');
        });
    });

    describe('regression: concurrent-reader visibility during backup+replace', () => {
        // The original implementation renamed filePath -> {filePath}.bak, then
        // separately renamed tmpPath -> filePath. On the sync path those two
        // fs calls are back-to-back with no yield point, so nothing else in
        // the process could ever observe the gap between them. Converting to
        // async introduced a real await between the two renames, during which
        // another concurrent reader on the same event loop (e.g. a second
        // server instance booting against the same data dir, as in
        // ws-task-handlers.test.ts's restart-persistence test) could land in
        // that window and see ENOENT. This reproduced the exact CI failure
        // before the fix (backup via copyFile instead of rename) landed.
        it('never lets a concurrent reader observe the target as missing across many writes', async () => {
            const filePath = join(testBaseDir, 'tasks.json');
            writeFileSync(filePath, JSON.stringify({ n: 0 }));

            let missingCount = 0;
            let stop = false;

            const writer = (async () => {
                for (let i = 1; i <= 60 && !stop; i++) {
                    await atomicWriteFileAsync(filePath, JSON.stringify({ n: i }), { backup: true });
                }
                stop = true;
            })();

            const reader = (async () => {
                while (!stop) {
                    if (!existsSync(filePath)) missingCount++;
                    // Yield so the writer's awaited fs calls actually get a turn.
                    await new Promise(res => setImmediate(res));
                }
            })();

            await Promise.all([writer, reader]);
            expect(missingCount).toBe(0);
        }, 20000);
    });

    describe('transient rename failure retry (Windows EPERM/EBUSY)', () => {
        beforeEach(() => {
            renameMockState.failuresRemaining = 0;
            renameMockState.errorCode = 'EPERM';
            renameMockState.calls = 0;
        });

        it('retries a transient EPERM on the final rename instead of failing the write', async () => {
            renameMockState.failuresRemaining = 1;
            renameMockState.errorCode = 'EPERM';

            const filePath = join(testBaseDir, 'retry.txt');
            await atomicWriteFileAsync(filePath, 'survived the retry');

            expect(readFileSync(filePath, 'utf-8')).toBe('survived the retry');
            // One failed attempt + one successful retry.
            expect(renameMockState.calls).toBe(2);
        });

        it('retries a transient EBUSY too, and gives up after exhausting its retry budget', async () => {
            // More failures than renameWithRetry's budget (4 delayed retries -> 5
            // total attempts) — the write must still fail, not retry forever.
            renameMockState.failuresRemaining = 10;
            renameMockState.errorCode = 'EBUSY';

            const filePath = join(testBaseDir, 'stillbusy.txt');
            await expect(atomicWriteFileAsync(filePath, 'data')).rejects.toThrow(/EBUSY/);
            expect(renameMockState.calls).toBe(5);
        }, 20000);

        it('does not retry (and fails immediately) on a non-transient error', async () => {
            renameMockState.failuresRemaining = 1;
            renameMockState.errorCode = 'ENOSPC';

            const filePath = join(testBaseDir, 'nospace.txt');
            await expect(atomicWriteFileAsync(filePath, 'data')).rejects.toThrow(/ENOSPC/);
            // Exactly one attempt -- renameWithRetry never retries a non EPERM/EBUSY code.
            expect(renameMockState.calls).toBe(1);
        });
    });
});
