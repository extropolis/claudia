/**
 * Atomic file write utility.
 *
 * Writes to a per-process temporary file first, then renames to the target.
 * `renameSync` is atomic on POSIX and near-atomic on Windows NTFS, so a
 * crash mid-write cannot leave the target file in a partial/empty state.
 *
 * Optional `.bak` rollover gives callers a one-step recovery point: a copy of
 * the previous good file is left at `{filePath}.bak` before the new file
 * takes its place. This is a COPY, not a rename-away — `filePath` itself is
 * never removed as a separate step, only ever replaced in the single final
 * rename below. Renaming the original out of the way first (as an earlier
 * version of this file did) opens a real window where `filePath` doesn't
 * exist at all between the two renames; on the sync path nothing else in the
 * process can observe that window (no yield point), but the async twin below
 * awaits each fs call, so another concurrent reader in the same event loop
 * (e.g. a second server instance booting against the same data dir) can land
 * exactly in that gap and see ENOENT. Copying instead of moving the backup
 * closes the gap for both variants.
 */

import { writeFileSync, renameSync, copyFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { writeFile, rename, copyFile, unlink, mkdir } from 'fs/promises';
import { dirname } from 'path';

/**
 * Windows can transiently refuse to rename onto an existing file with EPERM/
 * EBUSY (commonly real-time antivirus briefly holding the destination open
 * right after it's written) — a known issue in this codebase, previously hit
 * in history-file rotation (see the "close fd before rename" fix there). The
 * sync save path is low-frequency (shutdown/critical writes only) and hasn't
 * shown this in practice, so it's left alone; the async path below is the one
 * that fires often enough (every debounced save) to make a short retry worth
 * it rather than dropping an otherwise-successful save on a transient lock.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
    const delaysMs = [10, 25, 50, 100, 200, 400];
    for (let attempt = 0; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (attempt >= delaysMs.length || (code !== 'EPERM' && code !== 'EBUSY')) {
                throw error;
            }
            await new Promise(res => setTimeout(res, delaysMs[attempt]));
        }
    }
}

export interface AtomicWriteOptions {
    /** Text encoding for string payloads. Defaults to 'utf-8'. Ignored for Buffer. */
    encoding?: BufferEncoding;
    /**
     * If true, copy the existing target file to `{filePath}.bak` before placing
     * the new file. Gives callers a rolling one-step backup for recovery.
     * Default: false.
     */
    backup?: boolean;
}

/**
 * Atomically write data to a file.
 *
 * Writes to `{filePath}.{pid}.tmp` first, then renames to the target path.
 * If the write or rename fails, the original file remains intact and the
 * temp file is cleaned up.
 *
 * The per-process tmp filename prevents concurrent backend instances
 * (e.g. two `tsx watch` processes from a stale dev server) from racing
 * on the same staging file.
 */
export function atomicWriteFileSync(
    filePath: string,
    data: string | Buffer,
    options?: AtomicWriteOptions
): void {
    const { encoding, backup = false } = options ?? {};

    const tmpPath = `${filePath}.${process.pid}.tmp`;
    const bakPath = `${filePath}.bak`;
    const dir = dirname(filePath);

    // Ensure parent directory exists
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    try {
        // Write to temp file
        if (typeof data === 'string') {
            writeFileSync(tmpPath, data, encoding ?? 'utf-8');
        } else {
            writeFileSync(tmpPath, data);
        }

        // Optional: keep a backup of the previous good file before replacing.
        // Copy (not rename) so filePath is never briefly absent.
        if (backup && existsSync(filePath)) {
            try {
                copyFileSync(filePath, bakPath);
            } catch {
                // Backup is best-effort; continue with the rename.
            }
        }

        // Atomic rename (POSIX) / near-atomic (NTFS) — the only step that
        // touches filePath itself, so it's never removed without an
        // immediate replacement.
        renameSync(tmpPath, filePath);
    } catch (error) {
        // Clean up our tmp file on failure so we don't leave junk behind.
        try {
            if (existsSync(tmpPath)) unlinkSync(tmpPath);
        } catch {
            // Ignore cleanup errors
        }
        throw error;
    }
}

/**
 * Async twin of {@link atomicWriteFileSync}, for callers on a non-blocking save
 * path (e.g. a debounced background save with many concurrent writers) that must
 * not stall the event loop. Same tmp-file + optional `.bak` rollover + rename
 * semantics — just via `fs/promises` instead of the sync fs API.
 *
 * Not a replacement for the sync version: callers that must guarantee a write
 * completes before the next synchronous statement runs (e.g. immediately before
 * process exit on shutdown) should keep using `atomicWriteFileSync`.
 */
export async function atomicWriteFileAsync(
    filePath: string,
    data: string | Buffer,
    options?: AtomicWriteOptions
): Promise<void> {
    const { encoding, backup = false } = options ?? {};

    const tmpPath = `${filePath}.${process.pid}.tmp`;
    const bakPath = `${filePath}.bak`;
    const dir = dirname(filePath);

    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
    }

    try {
        if (typeof data === 'string') {
            await writeFile(tmpPath, data, encoding ?? 'utf-8');
        } else {
            await writeFile(tmpPath, data);
        }

        // Copy (not rename) so filePath is never briefly absent to a
        // concurrent reader elsewhere in this process's event loop.
        if (backup && existsSync(filePath)) {
            try {
                await copyFile(filePath, bakPath);
            } catch {
                // Backup is best-effort; continue with the rename.
            }
        }

        // The only step that touches filePath itself — a single atomic
        // replace, never a remove-then-recreate. Retries transient Windows
        // EPERM/EBUSY (see renameWithRetry) rather than failing the save.
        await renameWithRetry(tmpPath, filePath);
    } catch (error) {
        try {
            if (existsSync(tmpPath)) await unlink(tmpPath);
        } catch {
            // Ignore cleanup errors
        }
        throw error;
    }
}
