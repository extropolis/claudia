/**
 * Schema versioning utility for JSON persistence files.
 *
 * Wraps data in a versioned envelope: `{ schemaVersion: N, data: ... }` so
 * stores can evolve their on-disk shape without breaking existing files.
 * A legacy (unversioned) file is treated as version 0 and can be passed
 * through `legacyLoader` to normalize into the v0 shape before migrations run.
 *
 * Writes go through `atomicWriteFileSync` so a crash mid-save can't corrupt
 * the file.
 */

import { readFileSync, existsSync } from 'fs';
import { atomicWriteFileSync } from './atomic-write.js';

/** Versioned file envelope. */
export interface VersionedFile<T> {
  schemaVersion: number;
  data: T;
}

/** A migration function that transforms data from version N to N+1. */
export type Migration<T = unknown> = (data: T) => T;

export interface LoadVersionedOptions<T> {
  /** Current schema version for this file type. */
  currentVersion: number;
  /**
   * Ordered migrations: `migrations[0]` upgrades v0→v1, `migrations[1]`
   * upgrades v1→v2, etc.
   */
  migrations?: Migration[];
  /** Default data if file doesn't exist or can't be parsed. */
  defaultData: T;
  /**
   * Legacy loader: if the file exists but has no `schemaVersion` field,
   * this function extracts the data from the raw parsed JSON. Return the
   * data in the shape expected by version 0 (pre-versioning).
   */
  legacyLoader?: (raw: unknown) => T;
}

/**
 * Load a versioned JSON file, running migrations if needed.
 *
 * - If the file doesn't exist: returns `defaultData`.
 * - If the file parses but has no `schemaVersion`: treats it as v0 and
 *   uses `legacyLoader` to normalize.
 * - Runs migrations sequentially from the file's version to `currentVersion`.
 * - Persists the migrated form so the next load is fast.
 */
export function loadVersioned<T>(filePath: string, options: LoadVersionedOptions<T>): T {
  const { currentVersion, migrations = [], defaultData, legacyLoader } = options;

  if (!existsSync(filePath)) {
    return defaultData;
  }

  let raw: unknown;
  try {
    const content = readFileSync(filePath, 'utf-8');
    raw = JSON.parse(content);
  } catch (error) {
    console.error(`[SchemaVersion] Failed to parse ${filePath}:`, error);
    return defaultData;
  }

  let fileVersion: number;
  let data: T;

  if (raw && typeof raw === 'object' && 'schemaVersion' in raw) {
    const versioned = raw as VersionedFile<T>;
    fileVersion = versioned.schemaVersion;
    data = versioned.data;
  } else {
    // Legacy (unversioned) file.
    fileVersion = 0;
    data = legacyLoader ? legacyLoader(raw) : (raw as T);
  }

  if (fileVersion < currentVersion) {
    for (let v = fileVersion; v < currentVersion; v++) {
      const migration = migrations[v];
      if (migration) {
        try {
          data = migration(data) as T;
          console.log(`[SchemaVersion] Migrated ${filePath} from v${v} to v${v + 1}`);
        } catch (error) {
          console.error(`[SchemaVersion] Migration v${v}→v${v + 1} failed for ${filePath}:`, error);
          // Return what we have so far rather than losing everything.
          break;
        }
      }
    }

    saveVersioned(filePath, data, currentVersion);
    console.log(`[SchemaVersion] Saved migrated ${filePath} at v${currentVersion}`);
  }

  return data;
}

/** Save data to a versioned JSON file using atomic writes. */
export function saveVersioned<T>(filePath: string, data: T, version: number): void {
  const envelope: VersionedFile<T> = {
    schemaVersion: version,
    data,
  };
  atomicWriteFileSync(filePath, JSON.stringify(envelope, null, 2));
}
