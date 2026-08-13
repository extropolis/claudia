/**
 * Integration tests for the workspace FILE-OPERATION HTTP routes in server.ts.
 *
 * Routes covered:
 *   GET    /api/workspaces
 *   GET    /api/workspaces/files          (list directory)
 *   POST   /api/workspaces/files/copy     (file + recursive directory)
 *   POST   /api/workspaces/files/move     (rename + move into subdir)
 *   DELETE /api/workspaces/files          (file + recursive directory)
 *   POST   /api/workspaces/files/reveal   (VALIDATION ONLY — see note below)
 *   GET    /api/workspaces/read-file      (text + image/base64 branch)
 *   POST   /api/workspaces/save-file      (overwrite + create)
 *
 * The point of this file is the CONTAINMENT contract. These routes used to do
 * `resolvedPath.startsWith(resolvedWorkspace)`, which is a prefix test, not a
 * containment test: with workspace `<base>/repo`, the path
 * `<base>/repo-secrets/creds.txt` passes `startsWith` while living entirely
 * outside the workspace. They now use `isPathInside()` from validation.ts,
 * which compares on a separator boundary. Every `repo-secrets` test below FAILS
 * against the old prefix check and PASSES against the fix — and the final
 * describe block asserts on the actual disk state afterwards, which is the only
 * assertion that really proves nothing escaped.
 *
 * Layout (all under a temp root inside homedir(), never os.tmpdir(): on macOS
 * os.tmpdir() lives under /var, which validateWorkspacePath blocklists):
 *   <root>/repo             <- the workspace
 *   <root>/repo-secrets/creds.txt   <- sibling sharing the workspace's prefix
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { startHarness, type Harness } from './helpers/server-harness.js';

const SECRET = 'TOP SECRET CREDENTIALS\n';
const README = '# repo\n';

let h: Harness;
let root: string;
let repo: string;
let secretsDir: string;
let credsFile: string;

/** URL for GET /api/workspaces/files */
const filesUrl = (workspace: string | null, path?: string) => {
    const q = new URLSearchParams();
    if (workspace !== null) q.set('workspace', workspace);
    if (path !== undefined) q.set('path', path);
    return `/api/workspaces/files?${q.toString()}`;
};

/** URL for GET /api/workspaces/read-file */
const readUrl = (workspace: string | null, file?: string) => {
    const q = new URLSearchParams();
    if (workspace !== null) q.set('workspace', workspace);
    if (file !== undefined) q.set('file', file);
    return `/api/workspaces/read-file?${q.toString()}`;
};

interface FileItem {
    name: string;
    type: 'file' | 'directory';
    path: string;
    size?: number;
    childCount?: number;
}

beforeAll(async () => {
    // The workspace dir must exist BEFORE createApp(): WorkspaceStore.loadConfig()
    // filters out workspaces whose id no longer exists on disk. So the tree is
    // built first, then handed to the harness as a seeded workspace.
    root = mkdtempSync(join(homedir(), '.claudia-files-test-'));
    repo = join(root, 'repo');
    secretsDir = join(root, 'repo-secrets');
    credsFile = join(secretsDir, 'creds.txt');

    mkdirSync(repo, { recursive: true });
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(credsFile, SECRET);

    writeFileSync(join(repo, 'README.md'), README);
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');          // hidden-but-important -> listed
    writeFileSync(join(repo, '.hidden-file'), 'nope\n');       // hidden -> skipped
    mkdirSync(join(repo, 'node_modules'), { recursive: true }); // ignored dir
    writeFileSync(join(repo, 'node_modules', 'junk.js'), '//\n');

    // A fully controlled subtree so the listing assertions can be exact.
    const tree = join(repo, 'tree');
    mkdirSync(join(tree, 'alpha'), { recursive: true });
    mkdirSync(join(tree, 'beta'), { recursive: true });
    mkdirSync(join(tree, 'node_modules'), { recursive: true });
    writeFileSync(join(tree, 'alpha', 'one.txt'), '1\n');
    writeFileSync(join(tree, 'alpha', 'two.txt'), '2\n');
    writeFileSync(join(tree, 'node_modules', 'x.js'), '//\n');
    writeFileSync(join(tree, 'a.txt'), 'aaa\n');
    writeFileSync(join(tree, 'b.md'), 'bbbb\n');
    writeFileSync(join(tree, '.DS_Store'), 'junk');            // ignored file
    writeFileSync(join(tree, '.dotfile'), 'hidden');           // hidden -> skipped

    h = await startHarness({
        prefix: '.claudia-files-harness-',
        workspaces: [{ id: repo, name: 'repo' }],
    });
}, 30000);

afterAll(async () => {
    if (h) await h.stop();                                  // restores env + rm -rf's the harness base
    try {
        // Tolerant for the same reason as the harness: Windows holds the git
        // worktree handles briefly after shutdown and rmdir throws EBUSY.
        if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
        // Ignore cleanup errors
    }
});

describe('GET /api/workspaces', () => {
    it('returns the seeded workspace with its real record shape', async () => {
        const { status, body } = await h.req<{ workspaces: Array<Record<string, unknown>> }>('/api/workspaces');
        expect(status).toBe(200);
        expect(Array.isArray(body.workspaces)).toBe(true);
        expect(body.workspaces).toHaveLength(1);
        const ws = body.workspaces[0];
        expect(ws.id).toBe(repo);
        expect(ws.name).toBe('repo');
        expect(typeof ws.createdAt).toBe('string');
        expect(Number.isNaN(Date.parse(ws.createdAt as string))).toBe(false);
    });
});

describe('GET /api/workspaces/files', () => {
    it('lists a subdirectory exactly: dirs first, ignored/hidden entries filtered', async () => {
        const { status, body } = await h.req<{ path: string; workspace: string; items: FileItem[] }>(
            filesUrl(repo, 'tree'),
        );
        expect(status).toBe(200);
        expect(body.path).toBe('tree');
        expect(body.workspace).toBe(repo);

        // node_modules (ignored dir), .DS_Store (ignored file) and .dotfile (hidden) are gone.
        expect(body.items.map(i => i.name)).toEqual(['alpha', 'beta', 'a.txt', 'b.md']);
        expect(body.items.map(i => i.type)).toEqual(['directory', 'directory', 'file', 'file']);
        // Relative paths are prefixed with the sub path.
        expect(body.items.map(i => i.path)).toEqual(['tree/alpha', 'tree/beta', 'tree/a.txt', 'tree/b.md']);
        expect(body.items[0].childCount).toBe(2);
        expect(body.items[1].childCount).toBe(0);
        expect(body.items[2].size).toBe(Buffer.byteLength('aaa\n'));
        expect(body.items[3].size).toBe(Buffer.byteLength('bbbb\n'));
    });

    it('lists the workspace root, keeping .env but dropping node_modules and other dotfiles', async () => {
        const { status, body } = await h.req<{ path: string; items: FileItem[] }>(filesUrl(repo));
        expect(status).toBe(200);
        expect(body.path).toBe('.');
        const names = body.items.map(i => i.name);
        expect(names).toContain('README.md');
        expect(names).toContain('.env');       // hidden-but-important allowlist
        expect(names).toContain('tree');
        expect(names).not.toContain('node_modules');
        expect(names).not.toContain('.hidden-file');
        const readme = body.items.find(i => i.name === 'README.md')!;
        expect(readme).toMatchObject({ type: 'file', path: 'README.md', size: Buffer.byteLength(README) });
    });

    it('400s (not 500) when workspace is missing', async () => {
        const { status, body } = await h.req<{ error: string }>('/api/workspaces/files');
        expect(status).toBe(400);
        expect(body.error).toBe('workspace query parameter is required');
    });

    it('404s for a directory that does not exist', async () => {
        const { status, body } = await h.req<{ error: string }>(filesUrl(repo, 'does-not-exist'));
        expect(status).toBe(404);
        expect(body.error).toBe('Directory not found');
    });

    it('403s on plain ../ traversal', async () => {
        const { status, body } = await h.req<{ error: string }>(filesUrl(repo, '..'));
        expect(status).toBe(403);
        expect(body.error).toBe('Path traversal not allowed');
    });

    it('403s on the sibling-prefix escape ../repo-secrets (regression: prefix vs boundary)', async () => {
        for (const p of ['../repo-secrets', '../repo-secrets/', 'tree/../../repo-secrets']) {
            const { status, body } = await h.req<{ error: string; items?: FileItem[] }>(filesUrl(repo, p));
            expect({ p, status }).toEqual({ p, status: 403 });
            expect(body.items).toBeUndefined();
        }
    });
});

describe('POST /api/workspaces/files/copy', () => {
    beforeEach(() => {
        rmSync(join(repo, 'scratch'), { recursive: true, force: true });
        mkdirSync(join(repo, 'scratch'), { recursive: true });
    });

    it('copies a file and leaves the source in place', async () => {
        const { status, body } = await h.send('POST', '/api/workspaces/files/copy', {
            workspace: repo, sourcePath: 'README.md', destinationPath: 'scratch/README-copy.md',
        });
        expect(status).toBe(200);
        expect(body).toEqual({ success: true, message: 'File/directory copied successfully' });
        expect(readFileSync(join(repo, 'scratch', 'README-copy.md'), 'utf-8')).toBe(README);
        expect(existsSync(join(repo, 'README.md'))).toBe(true);
    });

    it('copies a directory recursively', async () => {
        const { status, body } = await h.send('POST', '/api/workspaces/files/copy', {
            workspace: repo, sourcePath: 'tree/alpha', destinationPath: 'scratch/alpha-copy',
        });
        expect(status).toBe(200);
        expect(body).toEqual({ success: true, message: 'File/directory copied successfully' });
        expect(readdirSync(join(repo, 'scratch', 'alpha-copy')).sort()).toEqual(['one.txt', 'two.txt']);
        expect(readFileSync(join(repo, 'scratch', 'alpha-copy', 'one.txt'), 'utf-8')).toBe('1\n');
        expect(existsSync(join(repo, 'tree', 'alpha', 'one.txt'))).toBe(true);
    });

    it('400s (not 500) when any of workspace/sourcePath/destinationPath is missing', async () => {
        const bodies = [
            {},
            { workspace: repo },
            { workspace: repo, sourcePath: 'README.md' },
            { sourcePath: 'README.md', destinationPath: 'scratch/x.md' },
        ];
        for (const b of bodies) {
            const { status, body } = await h.send<{ error: string }>('POST', '/api/workspaces/files/copy', b);
            expect({ b, status }).toEqual({ b, status: 400 });
            expect(body.error).toBe('workspace, sourcePath, and destinationPath are required');
        }
    });

    it('404s when the source does not exist', async () => {
        const { status, body } = await h.send<{ error: string }>('POST', '/api/workspaces/files/copy', {
            workspace: repo, sourcePath: 'nope.txt', destinationPath: 'scratch/nope.txt',
        });
        expect(status).toBe(404);
        expect(body.error).toBe('Source file not found');
    });

    it('403s when sourcePath escapes to the prefix-sibling dir, and copies nothing', async () => {
        const { status, body } = await h.send<{ error: string }>('POST', '/api/workspaces/files/copy', {
            workspace: repo, sourcePath: '../repo-secrets/creds.txt', destinationPath: 'scratch/stolen.txt',
        });
        expect(status).toBe(403);
        expect(body.error).toBe('Path traversal not allowed');
        expect(existsSync(join(repo, 'scratch', 'stolen.txt'))).toBe(false);
    });

    it('403s when destinationPath escapes to the prefix-sibling dir, and writes nothing', async () => {
        const { status } = await h.send('POST', '/api/workspaces/files/copy', {
            workspace: repo, sourcePath: 'README.md', destinationPath: '../repo-secrets/planted.md',
        });
        expect(status).toBe(403);
        expect(existsSync(join(secretsDir, 'planted.md'))).toBe(false);
    });

    it('403s on absolute paths outside the workspace (resolve() honours them)', async () => {
        const abs = await h.send('POST', '/api/workspaces/files/copy', {
            workspace: repo, sourcePath: credsFile, destinationPath: 'scratch/abs.txt',
        });
        expect(abs.status).toBe(403);
        expect(existsSync(join(repo, 'scratch', 'abs.txt'))).toBe(false);

        const absDest = await h.send('POST', '/api/workspaces/files/copy', {
            workspace: repo, sourcePath: 'README.md', destinationPath: join(secretsDir, 'abs-planted.md'),
        });
        expect(absDest.status).toBe(403);
        expect(existsSync(join(secretsDir, 'abs-planted.md'))).toBe(false);
    });
});

describe('POST /api/workspaces/files/move', () => {
    beforeEach(() => {
        rmSync(join(repo, 'scratch'), { recursive: true, force: true });
        mkdirSync(join(repo, 'scratch', 'sub'), { recursive: true });
        writeFileSync(join(repo, 'scratch', 'to-move.txt'), 'movable\n');
    });

    it('renames a file: source is gone, destination has the content', async () => {
        const { status, body } = await h.send('POST', '/api/workspaces/files/move', {
            workspace: repo, sourcePath: 'scratch/to-move.txt', destinationPath: 'scratch/renamed.txt',
        });
        expect(status).toBe(200);
        expect(body).toEqual({ success: true, message: 'File/directory moved successfully' });
        expect(existsSync(join(repo, 'scratch', 'to-move.txt'))).toBe(false);
        expect(readFileSync(join(repo, 'scratch', 'renamed.txt'), 'utf-8')).toBe('movable\n');
    });

    it('moves a file into a subdirectory', async () => {
        const { status } = await h.send('POST', '/api/workspaces/files/move', {
            workspace: repo, sourcePath: 'scratch/to-move.txt', destinationPath: 'scratch/sub/to-move.txt',
        });
        expect(status).toBe(200);
        expect(existsSync(join(repo, 'scratch', 'to-move.txt'))).toBe(false);
        expect(readFileSync(join(repo, 'scratch', 'sub', 'to-move.txt'), 'utf-8')).toBe('movable\n');
    });

    it('400s (not 500) on missing params', async () => {
        const { status, body } = await h.send<{ error: string }>('POST', '/api/workspaces/files/move', {
            workspace: repo, sourcePath: 'scratch/to-move.txt',
        });
        expect(status).toBe(400);
        expect(body.error).toBe('workspace, sourcePath, and destinationPath are required');
    });

    it('404s when the source does not exist', async () => {
        const { status, body } = await h.send<{ error: string }>('POST', '/api/workspaces/files/move', {
            workspace: repo, sourcePath: 'scratch/ghost.txt', destinationPath: 'scratch/ghost2.txt',
        });
        expect(status).toBe(404);
        expect(body.error).toBe('Source file not found');
    });

    it('403s on the sibling-prefix escape for either side, and moves nothing', async () => {
        const stealing = await h.send<{ error: string }>('POST', '/api/workspaces/files/move', {
            workspace: repo, sourcePath: '../repo-secrets/creds.txt', destinationPath: 'scratch/stolen.txt',
        });
        expect(stealing.status).toBe(403);
        expect(stealing.body.error).toBe('Path traversal not allowed');
        expect(existsSync(credsFile)).toBe(true);                  // NOT moved away
        expect(existsSync(join(repo, 'scratch', 'stolen.txt'))).toBe(false);

        const planting = await h.send('POST', '/api/workspaces/files/move', {
            workspace: repo, sourcePath: 'scratch/to-move.txt', destinationPath: '../repo-secrets/planted.txt',
        });
        expect(planting.status).toBe(403);
        expect(existsSync(join(secretsDir, 'planted.txt'))).toBe(false);
        expect(existsSync(join(repo, 'scratch', 'to-move.txt'))).toBe(true); // source untouched
    });

    it('403s on an absolute path outside the workspace', async () => {
        const { status } = await h.send('POST', '/api/workspaces/files/move', {
            workspace: repo, sourcePath: 'scratch/to-move.txt', destinationPath: join(secretsDir, 'abs.txt'),
        });
        expect(status).toBe(403);
        expect(existsSync(join(secretsDir, 'abs.txt'))).toBe(false);
    });
});

describe('DELETE /api/workspaces/files', () => {
    beforeEach(() => {
        rmSync(join(repo, 'scratch'), { recursive: true, force: true });
        mkdirSync(join(repo, 'scratch', 'doomed-dir', 'nested'), { recursive: true });
        writeFileSync(join(repo, 'scratch', 'doomed.txt'), 'bye\n');
        writeFileSync(join(repo, 'scratch', 'doomed-dir', 'nested', 'deep.txt'), 'deep\n');
    });

    it('deletes a file', async () => {
        const { status, body } = await h.send('DELETE', '/api/workspaces/files', {
            workspace: repo, path: 'scratch/doomed.txt',
        });
        expect(status).toBe(200);
        expect(body).toEqual({ success: true, message: 'File/directory deleted successfully' });
        expect(existsSync(join(repo, 'scratch', 'doomed.txt'))).toBe(false);
    });

    it('deletes a directory recursively', async () => {
        const { status, body } = await h.send('DELETE', '/api/workspaces/files', {
            workspace: repo, path: 'scratch/doomed-dir',
        });
        expect(status).toBe(200);
        expect(body).toEqual({ success: true, message: 'File/directory deleted successfully' });
        expect(existsSync(join(repo, 'scratch', 'doomed-dir'))).toBe(false);
    });

    it('400s (not 500) on missing params', async () => {
        for (const b of [{}, { workspace: repo }, { path: 'scratch/doomed.txt' }]) {
            const { status, body } = await h.send<{ error: string }>('DELETE', '/api/workspaces/files', b);
            expect({ b, status }).toEqual({ b, status: 400 });
            expect(body.error).toBe('workspace and path are required');
        }
    });

    it('404s when the path does not exist', async () => {
        const { status, body } = await h.send<{ error: string }>('DELETE', '/api/workspaces/files', {
            workspace: repo, path: 'scratch/never-existed.txt',
        });
        expect(status).toBe(404);
        expect(body.error).toBe('File not found');
    });

    it('403s on the sibling-prefix escape — the DATA LOSS case — and deletes nothing', async () => {
        const { status, body } = await h.send<{ error: string }>('DELETE', '/api/workspaces/files', {
            workspace: repo, path: '../repo-secrets/creds.txt',
        });
        expect(status).toBe(403);
        expect(body.error).toBe('Path traversal not allowed');
        expect(existsSync(credsFile)).toBe(true);
        expect(readFileSync(credsFile, 'utf-8')).toBe(SECRET);
    });

    it('403s on deleting the whole sibling directory', async () => {
        const { status } = await h.send('DELETE', '/api/workspaces/files', {
            workspace: repo, path: '../repo-secrets',
        });
        expect(status).toBe(403);
        expect(existsSync(secretsDir)).toBe(true);
        expect(readdirSync(secretsDir)).toEqual(['creds.txt']);
    });

    it('403s on an absolute path outside the workspace', async () => {
        const { status } = await h.send('DELETE', '/api/workspaces/files', {
            workspace: repo, path: credsFile,
        });
        expect(status).toBe(403);
        expect(existsSync(credsFile)).toBe(true);
    });
});

describe('POST /api/workspaces/files/reveal', () => {
    // VALIDATION PATHS ONLY. The happy path shells out to `open -R` / explorer.exe /
    // xdg-open, which would pop a Finder window on the developer's machine (and hang
    // or fail in CI), so it is deliberately NOT tested here. Every assertion below
    // returns before the exec.

    it('400s (not 500) on missing params', async () => {
        for (const b of [{}, { workspace: repo }, { path: 'README.md' }]) {
            const { status, body } = await h.send<{ error: string }>('POST', '/api/workspaces/files/reveal', b);
            expect({ b, status }).toEqual({ b, status: 400 });
            expect(body.error).toBe('workspace and path are required');
        }
    });

    it('403s on the sibling-prefix escape and on plain ../ traversal', async () => {
        for (const p of ['../repo-secrets/creds.txt', '../repo-secrets', '..', credsFile]) {
            const { status, body } = await h.send<{ error: string }>('POST', '/api/workspaces/files/reveal', {
                workspace: repo, path: p,
            });
            expect({ p, status }).toEqual({ p, status: 403 });
            expect(body.error).toBe('Path traversal not allowed');
        }
    });

    it('404s for a path inside the workspace that does not exist', async () => {
        const { status, body } = await h.send<{ error: string }>('POST', '/api/workspaces/files/reveal', {
            workspace: repo, path: 'not-here.txt',
        });
        expect(status).toBe(404);
        expect(body.error).toBe('File not found');
    });
});

describe('GET /api/workspaces/read-file', () => {
    it('returns text content, the relative path and the byte size', async () => {
        const { status, body } = await h.req<{ path: string; content: string; size: number; isImage?: boolean }>(
            readUrl(repo, 'README.md'),
        );
        expect(status).toBe(200);
        expect(body).toEqual({
            path: 'README.md',
            content: README,
            size: Buffer.byteLength(README),
        });
        expect(body.isImage).toBeUndefined();
    });

    it('returns images as a base64 data URI', async () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
        writeFileSync(join(repo, 'pixel.png'), png);
        try {
            const { status, body } = await h.req<{ path: string; content: string; isImage: boolean; size: number }>(
                readUrl(repo, 'pixel.png'),
            );
            expect(status).toBe(200);
            expect(body.isImage).toBe(true);
            expect(body.path).toBe('pixel.png');
            expect(body.size).toBe(png.length);
            expect(body.content.startsWith('data:image/png;base64,')).toBe(true);
            const decoded = Buffer.from(body.content.split(',')[1], 'base64');
            expect(decoded.equals(png)).toBe(true);
        } finally {
            rmSync(join(repo, 'pixel.png'), { force: true });
        }
    });

    it('400s (not 500) when workspace or file is missing', async () => {
        const noWs = await h.req<{ error: string }>('/api/workspaces/read-file?file=README.md');
        expect(noWs.status).toBe(400);
        expect(noWs.body.error).toBe('workspace query parameter is required');

        const noFile = await h.req<{ error: string }>(readUrl(repo));
        expect(noFile.status).toBe(400);
        expect(noFile.body.error).toBe('file query parameter is required');
    });

    it('400s when the target is a directory, not a file', async () => {
        const { status, body } = await h.req<{ error: string }>(readUrl(repo, 'tree'));
        expect(status).toBe(400);
        expect(body.error).toBe('Path is not a file');
    });

    it('404s for a file that does not exist', async () => {
        const { status, body } = await h.req<{ error: string }>(readUrl(repo, 'ghost.md'));
        expect(status).toBe(404);
        expect(body.error).toBe('File not found');
    });

    it('403s on the sibling-prefix escape (regression: prefix vs boundary)', async () => {
        for (const f of ['../repo-secrets/creds.txt', '../repo-secrets/./creds.txt', 'tree/../../repo-secrets/creds.txt']) {
            const { status, body } = await h.req<{ error: string; content?: string }>(readUrl(repo, f));
            expect({ f, status }).toEqual({ f, status: 403 });
            expect(body.error).toBe('Path traversal not allowed');
            expect(body.content).toBeUndefined();
        }
    });

    it('never leaks a file via an absolute path outside the workspace', async () => {
        // This route builds the target with join(workspace, file), and join() does
        // NOT honour a leading '/', so an absolute path becomes <repo>/<abs> and is
        // contained. It therefore 404s rather than 403s — different status, same
        // guarantee: the outside file is not read.
        const { status, body } = await h.req<{ error: string; content?: string }>(readUrl(repo, credsFile));
        expect([403, 404]).toContain(status);
        expect(body.content).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain('TOP SECRET');
    });
});

describe('POST /api/workspaces/save-file', () => {
    beforeEach(() => {
        rmSync(join(repo, 'scratch'), { recursive: true, force: true });
        mkdirSync(join(repo, 'scratch'), { recursive: true });
        writeFileSync(join(repo, 'scratch', 'existing.txt'), 'old content\n');
    });

    it('overwrites an existing file and reports the new size', async () => {
        const content = 'brand new content\n';
        const { status, body } = await h.send('POST', '/api/workspaces/save-file', {
            workspace: repo, file: 'scratch/existing.txt', content,
        });
        expect(status).toBe(200);
        expect(body).toEqual({ path: 'scratch/existing.txt', size: Buffer.byteLength(content), success: true });
        expect(readFileSync(join(repo, 'scratch', 'existing.txt'), 'utf-8')).toBe(content);
    });

    it('creates a file that does not exist yet (no 404 branch on this route)', async () => {
        const { status, body } = await h.send('POST', '/api/workspaces/save-file', {
            workspace: repo, file: 'scratch/created.txt', content: 'hello\n',
        });
        expect(status).toBe(200);
        expect(body).toEqual({ path: 'scratch/created.txt', size: 6, success: true });
        expect(readFileSync(join(repo, 'scratch', 'created.txt'), 'utf-8')).toBe('hello\n');
    });

    it('accepts empty-string content (only undefined is rejected)', async () => {
        const { status, body } = await h.send('POST', '/api/workspaces/save-file', {
            workspace: repo, file: 'scratch/existing.txt', content: '',
        });
        expect(status).toBe(200);
        expect(body).toMatchObject({ size: 0, success: true });
        expect(readFileSync(join(repo, 'scratch', 'existing.txt'), 'utf-8')).toBe('');
    });

    it('400s (not 500) on each missing param', async () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{}, 'workspace parameter is required'],
            [{ workspace: repo }, 'file parameter is required'],
            [{ workspace: repo, file: 'scratch/existing.txt' }, 'content parameter is required'],
        ];
        for (const [b, error] of cases) {
            const { status, body } = await h.send<{ error: string }>('POST', '/api/workspaces/save-file', b);
            expect({ b, status }).toEqual({ b, status: 400 });
            expect(body.error).toBe(error);
        }
    });

    it('403s on the sibling-prefix escape — the OVERWRITE case — leaving the target untouched', async () => {
        const { status, body } = await h.send<{ error: string }>('POST', '/api/workspaces/save-file', {
            workspace: repo, file: '../repo-secrets/creds.txt', content: 'PWNED\n',
        });
        expect(status).toBe(403);
        expect(body.error).toBe('Path traversal not allowed');
        expect(readFileSync(credsFile, 'utf-8')).toBe(SECRET);
    });

    it('403s on plain ../ traversal and creates no file outside the workspace', async () => {
        const { status } = await h.send('POST', '/api/workspaces/save-file', {
            workspace: repo, file: '../planted.txt', content: 'PWNED\n',
        });
        expect(status).toBe(403);
        expect(existsSync(join(root, 'planted.txt'))).toBe(false);
    });

    it('never writes outside the workspace via an absolute path', async () => {
        // Same join() quirk as read-file: an absolute path is re-rooted under the
        // workspace instead of being rejected, so this fails on the missing parent
        // dir rather than on the containment check. Either way nothing outside the
        // workspace is written — that is the assertion that matters.
        const { status } = await h.send(
            'POST', '/api/workspaces/save-file',
            { workspace: repo, file: credsFile, content: 'PWNED\n' },
        );
        expect(status).toBeGreaterThanOrEqual(400);
        expect(readFileSync(credsFile, 'utf-8')).toBe(SECRET);
    });
});

/**
 * The assertion that actually proves containment: after running the full escape
 * matrix against every mutating route, the filesystem outside the workspace must
 * be byte-for-byte unchanged and must have gained nothing.
 *
 * Against the OLD `resolvedPath.startsWith(resolvedWorkspace)` check, every one
 * of these requests succeeded — creds.txt would be overwritten, then deleted,
 * and planted files would appear in <root>/repo-secrets.
 */
describe('containment regression: <root>/repo-secrets must survive every escape attempt', () => {
    const ESCAPES = ['../repo-secrets/creds.txt', '../repo-secrets/planted.txt', '../planted.txt', '..'];

    it('rejects every escape and leaves the outside filesystem untouched', async () => {
        expect(readFileSync(credsFile, 'utf-8')).toBe(SECRET); // precondition

        for (const p of ESCAPES) {
            const results = [
                await h.req(filesUrl(repo, p)),
                await h.req(readUrl(repo, p)),
                await h.send('POST', '/api/workspaces/save-file', { workspace: repo, file: p, content: 'PWNED\n' }),
                await h.send('DELETE', '/api/workspaces/files', { workspace: repo, path: p }),
                await h.send('POST', '/api/workspaces/files/reveal', { workspace: repo, path: p }),
                await h.send('POST', '/api/workspaces/files/copy', {
                    workspace: repo, sourcePath: 'README.md', destinationPath: p,
                }),
                await h.send('POST', '/api/workspaces/files/copy', {
                    workspace: repo, sourcePath: p, destinationPath: 'copied-out.txt',
                }),
                await h.send('POST', '/api/workspaces/files/move', {
                    workspace: repo, sourcePath: 'README.md', destinationPath: p,
                }),
                await h.send('POST', '/api/workspaces/files/move', {
                    workspace: repo, sourcePath: p, destinationPath: 'moved-out.txt',
                }),
            ];
            for (const r of results) {
                expect({ p, ok: r.status < 400 }).toEqual({ p, ok: false });
            }
        }

        // Nothing outside the workspace was read, written, moved or deleted.
        expect(readdirSync(root).sort()).toEqual(['repo', 'repo-secrets']);
        expect(readdirSync(secretsDir)).toEqual(['creds.txt']);
        expect(readFileSync(credsFile, 'utf-8')).toBe(SECRET);
        expect(existsSync(join(root, 'planted.txt'))).toBe(false);
        expect(existsSync(join(repo, 'copied-out.txt'))).toBe(false);
        expect(existsSync(join(repo, 'moved-out.txt'))).toBe(false);
        expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe(README);
    }, 30000);
});
