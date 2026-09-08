/**
 * Throwaway git repos for workspace tests.
 *
 * Created under ~/.claudia-e2e/workspaces (NOT os.tmpdir(): on macOS that
 * resolves under /var, which the backend's validateWorkspacePath blocklists,
 * so every "add workspace" call would be rejected).
 */
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WORKSPACES_DIR } from './env.js';

let counter = 0;

export interface TempRepo {
    /** Absolute path — this is also the workspace id the backend uses. */
    path: string;
    /** Folder basename — the workspace's default display name. */
    name: string;
}

/**
 * Create a git repo with one committed file (`README.md`) and one nested
 * directory, so file-explorer tests have a tree to walk.
 */
export function makeGitRepo(label: string): TempRepo {
    const name = `${label}-${++counter}`;
    const path = join(WORKSPACES_DIR, name);
    mkdirSync(join(path, 'src'), { recursive: true });

    writeFileSync(join(path, 'README.md'), `# ${name}\n\nE2E fixture repo.\n`);
    writeFileSync(
        join(path, 'src', 'hello.txt'),
        'CLAUDIA_E2E_FILE_CONTENT_MARKER\nsecond line\n',
    );

    const git = (...args: string[]) =>
        execFileSync('git', args, {
            cwd: path,
            stdio: 'ignore',
            env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
        });

    git('init', '-b', 'main');
    git('config', 'user.email', 'e2e@claudia.test');
    git('config', 'user.name', 'Claudia E2E');
    git('add', '-A');
    git('commit', '-m', 'initial');

    return { path, name };
}
