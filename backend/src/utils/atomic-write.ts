/**
 * Atomic file write utility.
 *
 * Writes to a per-process temporary file first, then renames to the target.
 * `renameSync` is atomic on POSIX and near-atomic on Windows NTFS, so a
 * crash mid-write cannot leave the target file in a partial/empty state.
 *
 * Optional `.bak` rollover gives callers a one-step recovery point: the
 * previous good file is renamed to `{filePath}.bak` before the new file
 * takes its place.
 */

import { writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

export interface AtomicWriteOptions {
  /** Text encoding for string payloads. Defaults to 'utf-8'. Ignored for Buffer. */
  encoding?: BufferEncoding;
  /**
   * If true, rename the existing target file to `{filePath}.bak` before placing
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
  options?: AtomicWriteOptions,
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
    if (backup && existsSync(filePath)) {
      try {
        renameSync(filePath, bakPath);
      } catch {
        // Backup is best-effort; continue with the rename.
      }
    }

    // Atomic rename (POSIX) / near-atomic (NTFS)
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
