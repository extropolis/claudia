import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

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
