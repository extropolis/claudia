/**
 * Tests for the portable state export (P0 task 10, spec §11.1).
 *
 * NOTE ON TEMP DIRECTORIES: every fixture lives under `os.homedir()`, never
 * `os.tmpdir()`. On macOS `/tmp` resolves under `/var`, which
 * `validateWorkspacePath` blocklists as a system path — anything workspace
 * shaped gets rejected before it reaches the code under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { homedir } from 'os';

import { exportState, SECRET_PATHS } from '../export-import/export.js';
import { startHarness, seedWorkspaceFile, seedTasksFile, makeTaskRecord, type Harness } from './helpers/server-harness.js';

// ---------------------------------------------------------------------------
// Fixture values. Every secret is a distinctive string so a test can assert on
// its literal absence from the exported bytes rather than on a key name — a
// key can be renamed and still leak the value.
// ---------------------------------------------------------------------------
const SECRETS = {
    anthropic: 'sk-ant-FIXTURE-ANTHROPIC-KEY',
    deepgram: 'FIXTURE-DEEPGRAM-KEY',
    hyperspace: 'FIXTURE-HYPERSPACE-KEY',
    aiCoreId: 'FIXTURE-AICORE-CLIENT-ID',
    aiCoreSecret: 'FIXTURE-AICORE-CLIENT-SECRET',
    jiraToken: 'FIXTURE-JIRA-API-TOKEN',
    jiraEmail: 'fixture-user@example.invalid',
    mcpEnv: 'FIXTURE-MCP-ENV-SECRET',
    mcpHeader: 'Bearer FIXTURE-MCP-HEADER-SECRET',
};

const WS_A = '/tmp-fixture/workspaces/alpha';
const WS_B = '/tmp-fixture/workspaces/beta';

/** Walk a directory tree, returning every file path relative to the root. */
function walk(root: string): string[] {
    const out: string[] = [];
    const visit = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) visit(full);
            else out.push(relative(root, full).split(sep).join('/'));
        }
    };
    if (existsSync(root)) visit(root);
    return out;
}

/** Concatenate every file in a tree so we can assert a value appears nowhere. */
function readAll(root: string): string {
    return walk(root)
        .map((rel) => {
            try {
                return readFileSync(join(root, rel), 'utf-8');
            } catch {
                return '';
            }
        })
        .join('\n');
}

describe('exportState', () => {
    let sandbox: string;
    let dataDir: string;
    let fakeHome: string;
    let out: string;

    beforeEach(() => {
        sandbox = mkdtempSync(join(homedir(), '.claudia-export-test-'));
        dataDir = join(sandbox, 'data');
        fakeHome = join(sandbox, 'home');
        out = join(sandbox, 'out');
        mkdirSync(dataDir, { recursive: true });
        mkdirSync(fakeHome, { recursive: true });

        // --- config.json: versioned envelope, every secret populated --------
        writeFileSync(
            join(dataDir, 'config.json'),
            JSON.stringify({
                schemaVersion: 1,
                data: {
                    skipPermissions: false,
                    backend: 'claude-code',
                    apiMode: 'custom-anthropic',
                    customAnthropicApiKey: SECRETS.anthropic,
                    deepgramApiKey: SECRETS.deepgram,
                    hyperspaceProxy: {
                        proxyUrl: 'http://localhost:6655',
                        apiKey: SECRETS.hyperspace,
                        model: 'anthropic--claude-4.5-sonnet',
                        alwaysThinkingEnabled: false,
                    },
                    aiCoreCredentials: {
                        clientId: SECRETS.aiCoreId,
                        clientSecret: SECRETS.aiCoreSecret,
                        authUrl: 'https://auth.example.invalid',
                        baseUrl: 'https://api.example.invalid',
                    },
                    jiraEnabled: true,
                    jira: {
                        baseUrl: 'https://example.atlassian.net',
                        email: SECRETS.jiraEmail,
                        apiToken: SECRETS.jiraToken,
                    },
                    // Non-secret settings that must survive verbatim. Note the
                    // "token" substring on three of these: a blunt key regex
                    // would eat them.
                    tokenTrackingEnabled: true,
                    tokenCostEnabled: false,
                    tokenPricing: { 'claude-opus-4': { input: 15, output: 75 } },
                    mcpServers: [
                        {
                            name: 'plain',
                            type: 'stdio',
                            command: 'node',
                            args: ['server.js'],
                            enabled: true,
                        },
                        {
                            name: 'withsecrets',
                            type: 'streamableHttp',
                            url: 'https://mcp.example.invalid',
                            enabled: true,
                            env: { API_SECRET: SECRETS.mcpEnv, LOG_LEVEL: 'debug' },
                            headers: { Authorization: SECRETS.mcpHeader },
                        },
                    ],
                },
            }),
            'utf-8'
        );

        // --- workspace-config.json: one parent, one worktree child ----------
        writeFileSync(
            join(dataDir, 'workspace-config.json'),
            JSON.stringify({
                schemaVersion: 1,
                data: {
                    workspaces: [
                        { id: WS_A, name: 'alpha', createdAt: '2026-01-01T00:00:00.000Z' },
                        {
                            id: WS_B,
                            name: 'beta',
                            createdAt: '2026-01-02T00:00:00.000Z',
                            worktreeParentId: WS_A,
                            worktreeBranch: 'feat/beta',
                        },
                    ],
                    activeWorkspaceId: WS_A,
                    recentWorkspaces: [],
                },
            }),
            'utf-8'
        );

        // --- tasks.json: two live tasks (envelope shape) --------------------
        writeFileSync(
            join(dataDir, 'tasks.json'),
            JSON.stringify({
                schemaVersion: 1,
                data: {
                    tasks: [
                        {
                            id: 'task-live-1',
                            prompt: 'do a thing',
                            workspaceId: WS_A,
                            createdAt: '2026-01-01T00:00:00.000Z',
                            lastActivity: '2026-01-01T01:00:00.000Z',
                            lastState: 'idle',
                            sessionId: 'session-live-1',
                        },
                        {
                            id: 'task-live-2',
                            prompt: 'do another thing',
                            workspaceId: WS_B,
                            createdAt: '2026-01-02T00:00:00.000Z',
                            lastActivity: '2026-01-02T01:00:00.000Z',
                            lastState: 'idle',
                            sessionId: 'session-live-2',
                        },
                    ],
                    // task-spawner writes archived metadata into BOTH tasks.json
                    // and archived-tasks.json, so the fixture mirrors that: an
                    // exporter that reads `tasks` without discriminating would
                    // pick this up and leak an archived transcript.
                    archivedTasks: [
                        {
                            id: 'task-archived-1',
                            prompt: 'old work',
                            workspaceId: WS_A,
                            createdAt: '2025-12-01T00:00:00.000Z',
                            lastActivity: '2025-12-01T01:00:00.000Z',
                            sessionId: 'session-archived-1',
                        },
                    ],
                },
            }),
            'utf-8'
        );

        // --- archived-tasks.json: LEGACY unversioned shape -------------------
        // Deliberately unversioned: main writes this file without an envelope,
        // so the reader must cope with both and report schemaVersion null.
        writeFileSync(
            join(dataDir, 'archived-tasks.json'),
            JSON.stringify({
                archivedTasks: [
                    {
                        id: 'task-archived-1',
                        prompt: 'old work',
                        workspaceId: WS_A,
                        createdAt: '2025-12-01T00:00:00.000Z',
                        lastActivity: '2025-12-01T01:00:00.000Z',
                        sessionId: 'session-archived-1',
                    },
                ],
            }),
            'utf-8'
        );

        writeFileSync(
            join(dataDir, 'checkpoints.json'),
            JSON.stringify({ schemaVersion: 2, data: { checkpoints: [{ id: 'cp-1', taskId: 'task-live-1' }] } }),
            'utf-8'
        );
        writeFileSync(join(dataDir, 'todos.json'), JSON.stringify({ todos: {} }), 'utf-8');

        // --- histories ------------------------------------------------------
        mkdirSync(join(dataDir, 'task-histories'), { recursive: true });
        writeFileSync(join(dataDir, 'task-histories', 'task-live-1.txt'), 'live history bytes', 'utf-8');
        mkdirSync(join(dataDir, 'archived-histories'), { recursive: true });
        writeFileSync(join(dataDir, 'archived-histories', 'task-archived-1.txt'), 'archived history bytes', 'utf-8');

        // --- files that must NEVER be exported ------------------------------
        writeFileSync(join(dataDir, 'instance.json'), JSON.stringify({ instanceId: 'instance-should-not-leak' }), 'utf-8');
        writeFileSync(join(dataDir, 'mcp-token'), 'MCP-TOKEN-SHOULD-NOT-LEAK', 'utf-8');
        writeFileSync(join(dataDir, 'auth-token'), 'AUTH-TOKEN-SHOULD-NOT-LEAK', 'utf-8');
        writeFileSync(join(dataDir, 'crash.log'), 'CRASH-SHOULD-NOT-LEAK', 'utf-8');
        writeFileSync(join(dataDir, 'session-recovery.json'), '{"recovery":"SHOULD-NOT-LEAK"}', 'utf-8');
        writeFileSync(join(dataDir, 'session-recovery.json.applied'), 'SHOULD-NOT-LEAK', 'utf-8');
        writeFileSync(join(dataDir, 'tasks.json.bak'), 'BAK-SHOULD-NOT-LEAK', 'utf-8');
        writeFileSync(join(dataDir, 'server.pid'), '12345', 'utf-8');
        writeFileSync(join(dataDir, 'scratch.tmp'), 'TMP-SHOULD-NOT-LEAK', 'utf-8');

        // --- agent session JSONL files under the fake home -------------------
        const projects = join(fakeHome, '.claude', 'projects');
        const mangle = (p: string) => p.replace(/[^a-zA-Z0-9-]/g, '-');
        mkdirSync(join(projects, mangle(WS_A)), { recursive: true });
        mkdirSync(join(projects, mangle(WS_B)), { recursive: true });
        writeFileSync(join(projects, mangle(WS_A), 'session-live-1.jsonl'), '{"type":"live-1"}\n', 'utf-8');
        writeFileSync(join(projects, mangle(WS_B), 'session-live-2.jsonl'), '{"type":"live-2"}\n', 'utf-8');
        writeFileSync(
            join(projects, mangle(WS_A), 'session-archived-1.jsonl'),
            '{"type":"ARCHIVED-SESSION-SHOULD-NOT-LEAK"}\n',
            'utf-8'
        );
    });

    afterEach(() => {
        rmSync(sandbox, { recursive: true, force: true });
    });

    const run = (opts: Partial<Parameters<typeof exportState>[1]> = {}) =>
        exportState(dataDir, { out, ...opts }, { homeDir: fakeHome });

    // -----------------------------------------------------------------------
    // Manifest
    // -----------------------------------------------------------------------
    describe('manifest', () => {
        it('describes the export, its source and its tiers', async () => {
            const manifest = await run();

            expect(manifest.formatVersion).toBe(1);
            expect(Date.parse(manifest.exportedAt)).not.toBeNaN();
            expect(manifest.claudiaVersion).toBeTruthy();
            expect(manifest.source.dataDir).toBe(dataDir);
            expect(manifest.source.homeDir).toBe(fakeHome);
            expect(manifest.source.platform).toBe(process.platform);
            expect(manifest.source.hostname).toBeTruthy();
            expect(manifest.tiers).toEqual({ secrets: false, histories: false, agentSessions: false });
        });

        it('lists workspaces with their worktree parentage', async () => {
            const manifest = await run();

            expect(manifest.workspaces).toEqual([
                { id: WS_A, name: 'alpha' },
                { id: WS_B, name: 'beta', worktreeParentId: WS_A },
            ]);
        });

        it('records the schema version of each state file, null when unversioned', async () => {
            const manifest = await run();

            expect(manifest.schemaVersions['config.json']).toBe(1);
            expect(manifest.schemaVersions['tasks.json']).toBe(1);
            expect(manifest.schemaVersions['checkpoints.json']).toBe(2);
            // Legacy shapes are recorded as null rather than omitted, so an
            // importer can tell "unversioned" from "absent".
            expect(manifest.schemaVersions['archived-tasks.json']).toBeNull();
            expect(manifest.schemaVersions['todos.json']).toBeNull();
            // Absent files are not listed at all.
            expect(manifest.schemaVersions).not.toHaveProperty('learnings.json');
            expect(manifest.schemaVersions).not.toHaveProperty('chat-history.json');
        });

        it('is written to manifest.json alongside the state', async () => {
            const manifest = await run();
            const onDisk = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf-8'));
            expect(onDisk).toEqual(JSON.parse(JSON.stringify(manifest)));
        });
    });

    // -----------------------------------------------------------------------
    // State tier
    // -----------------------------------------------------------------------
    describe('state tier', () => {
        it('copies the state files that exist and skips the ones that do not', async () => {
            await run();
            const files = walk(join(out, 'state'));

            expect(files.sort()).toEqual(
                [
                    'archived-tasks.json',
                    'checkpoints.json',
                    'config.json',
                    'tasks.json',
                    'todos.json',
                    'workspace-config.json',
                ].sort()
            );
        });

        it('preserves non-secret config verbatim, envelope included', async () => {
            await run();
            const cfg = JSON.parse(readFileSync(join(out, 'state', 'config.json'), 'utf-8'));

            expect(cfg.schemaVersion).toBe(1);
            expect(cfg.data.apiMode).toBe('custom-anthropic');
            expect(cfg.data.tokenTrackingEnabled).toBe(true);
            expect(cfg.data.tokenCostEnabled).toBe(false);
            expect(cfg.data.tokenPricing).toEqual({ 'claude-opus-4': { input: 15, output: 75 } });
            expect(cfg.data.jira.baseUrl).toBe('https://example.atlassian.net');
            expect(cfg.data.hyperspaceProxy.proxyUrl).toBe('http://localhost:6655');
            expect(cfg.data.aiCoreCredentials.authUrl).toBe('https://auth.example.invalid');
            expect(cfg.data.mcpServers[0]).toMatchObject({ name: 'plain', command: 'node' });
            // Structure is kept so an importer knows which keys to refill.
            expect(Object.keys(cfg.data.mcpServers[1].env).sort()).toEqual(['API_SECRET', 'LOG_LEVEL']);
        });

        it('copies task state through unchanged', async () => {
            await run();
            const tasks = JSON.parse(readFileSync(join(out, 'state', 'tasks.json'), 'utf-8'));
            expect(tasks.data.tasks.map((t: { id: string }) => t.id)).toEqual(['task-live-1', 'task-live-2']);
        });
    });

    // -----------------------------------------------------------------------
    // Secret stripping
    // -----------------------------------------------------------------------
    describe('secret stripping', () => {
        it('leaves no secret value anywhere in the default export', async () => {
            await run();
            const everything = readAll(out);

            for (const [label, value] of Object.entries(SECRETS)) {
                expect(everything, `secret "${label}" leaked into the export`).not.toContain(value);
            }
        });

        it('blanks secret strings in place rather than deleting the keys', async () => {
            await run();
            const cfg = JSON.parse(readFileSync(join(out, 'state', 'config.json'), 'utf-8'));

            expect(cfg.data.customAnthropicApiKey).toBe('');
            expect(cfg.data.deepgramApiKey).toBe('');
            expect(cfg.data.hyperspaceProxy.apiKey).toBe('');
            expect(cfg.data.aiCoreCredentials.clientId).toBe('');
            expect(cfg.data.aiCoreCredentials.clientSecret).toBe('');
            expect(cfg.data.jira.apiToken).toBe('');
            expect(cfg.data.jira.email).toBe('');
            expect(cfg.data.mcpServers[1].env.API_SECRET).toBe('');
            expect(cfg.data.mcpServers[1].env.LOG_LEVEL).toBe('');
            expect(cfg.data.mcpServers[1].headers.Authorization).toBe('');
        });

        it('writes no secrets.json unless asked', async () => {
            await run();
            expect(existsSync(join(out, 'secrets.json'))).toBe(false);
        });

        it('writes secrets.json at mode 0600 when asked', async () => {
            const manifest = await run({ withSecrets: true });
            const secretsPath = join(out, 'secrets.json');

            expect(manifest.tiers.secrets).toBe(true);
            expect(existsSync(secretsPath)).toBe(true);

            // Windows does not implement POSIX permission bits; asserting them
            // there tests the OS, not the code.
            if (process.platform !== 'win32') {
                expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
            }

            const secrets = JSON.parse(readFileSync(secretsPath, 'utf-8'));
            expect(secrets['config.json']).toMatchObject({
                customAnthropicApiKey: SECRETS.anthropic,
                deepgramApiKey: SECRETS.deepgram,
                'hyperspaceProxy.apiKey': SECRETS.hyperspace,
                'aiCoreCredentials.clientId': SECRETS.aiCoreId,
                'aiCoreCredentials.clientSecret': SECRETS.aiCoreSecret,
                'jira.apiToken': SECRETS.jiraToken,
                'jira.email': SECRETS.jiraEmail,
                'mcpServers[1].env.API_SECRET': SECRETS.mcpEnv,
                'mcpServers[1].headers.Authorization': SECRETS.mcpHeader,
            });
        });

        it('holds exactly the values stripped from config.json — no more, no less', async () => {
            await run({ withSecrets: true });
            const secrets = JSON.parse(readFileSync(join(out, 'secrets.json'), 'utf-8'))['config.json'];
            const cfg = JSON.parse(readFileSync(join(out, 'state', 'config.json'), 'utf-8'));

            // Every recorded secret must be blank in the exported config...
            for (const path of Object.keys(secrets)) {
                const value = path
                    .replace(/\[(\d+)\]/g, '.$1')
                    .split('.')
                    .reduce<any>((acc, k) => (acc == null ? acc : acc[k]), cfg.data);
                expect(value, `${path} should have been blanked`).toBe('');
            }
            // ...and nothing outside the stripped set should have been recorded.
            const recorded = Object.keys(secrets);
            expect(recorded).not.toContain('apiMode');
            expect(recorded).not.toContain('tokenPricing');
            expect(recorded).not.toContain('jira.baseUrl');
            // Every MCP env/header value is stripped wholesale — including ones
            // that look innocuous — so the whole map has to be recorded, or a
            // withSecrets export could not restore the server's environment.
            expect(recorded).toContain('mcpServers[1].env.LOG_LEVEL');
        });

        it('exports SECRET_PATHS covering every documented config secret', () => {
            expect(SECRET_PATHS).toEqual(
                expect.arrayContaining([
                    'customAnthropicApiKey',
                    'deepgramApiKey',
                    'hyperspaceProxy.apiKey',
                    'aiCoreCredentials.clientId',
                    'aiCoreCredentials.clientSecret',
                    'jira.apiToken',
                    'jira.email',
                ])
            );
        });

        it('catches an unknown future secret-shaped key', async () => {
            // A key nobody has enumerated yet: the heuristic must still blank
            // it, because the alternative is a silent leak on the next release.
            const cfgPath = join(dataDir, 'config.json');
            const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
            raw.data.futureProviderApiKey = 'FIXTURE-UNKNOWN-FUTURE-SECRET';
            raw.data.nested = { somethingSecret: 'FIXTURE-UNKNOWN-NESTED-SECRET' };
            writeFileSync(cfgPath, JSON.stringify(raw), 'utf-8');

            await run();
            const everything = readAll(out);
            expect(everything).not.toContain('FIXTURE-UNKNOWN-FUTURE-SECRET');
            expect(everything).not.toContain('FIXTURE-UNKNOWN-NESTED-SECRET');
        });
    });

    // -----------------------------------------------------------------------
    // Histories tier
    // -----------------------------------------------------------------------
    describe('histories tier', () => {
        it('is omitted by default', async () => {
            const manifest = await run();
            expect(manifest.tiers.histories).toBe(false);
            expect(existsSync(join(out, 'histories'))).toBe(false);
        });

        it('copies both history directories when asked', async () => {
            const manifest = await run({ withHistories: true });

            expect(manifest.tiers.histories).toBe(true);
            expect(readFileSync(join(out, 'histories', 'task-histories', 'task-live-1.txt'), 'utf-8')).toBe(
                'live history bytes'
            );
            expect(
                readFileSync(join(out, 'histories', 'archived-histories', 'task-archived-1.txt'), 'utf-8')
            ).toBe('archived history bytes');
        });

        it('tolerates a data dir with no history directories at all', async () => {
            rmSync(join(dataDir, 'task-histories'), { recursive: true, force: true });
            rmSync(join(dataDir, 'archived-histories'), { recursive: true, force: true });

            const manifest = await run({ withHistories: true });
            expect(manifest.tiers.histories).toBe(true);
            expect(walk(join(out, 'histories'))).toEqual([]);
        });
    });

    // -----------------------------------------------------------------------
    // Agent sessions tier
    // -----------------------------------------------------------------------
    describe('agent sessions tier', () => {
        it('is omitted by default', async () => {
            const manifest = await run();
            expect(manifest.tiers.agentSessions).toBe(false);
            expect(existsSync(join(out, 'agent-sessions'))).toBe(false);
        });

        it('exports sessions for live tasks only, keyed by backend and workspace', async () => {
            const manifest = await run({ withAgentSessions: true });
            expect(manifest.tiers.agentSessions).toBe(true);

            const files = walk(join(out, 'agent-sessions'));
            expect(files.sort()).toEqual(
                [
                    `claude-code/${encodeURIComponent(WS_A)}/session-live-1.jsonl`,
                    `claude-code/${encodeURIComponent(WS_B)}/session-live-2.jsonl`,
                ].sort()
            );
        });

        it('never exports an archived task session', async () => {
            await run({ withAgentSessions: true });
            const everything = readAll(out);
            expect(everything).not.toContain('ARCHIVED-SESSION-SHOULD-NOT-LEAK');
            expect(walk(join(out, 'agent-sessions')).join('\n')).not.toContain('session-archived-1');
        });

        it('skips tasks with no session id and sessions with no file on disk', async () => {
            const tasksPath = join(dataDir, 'tasks.json');
            const raw = JSON.parse(readFileSync(tasksPath, 'utf-8'));
            raw.data.tasks.push(
                { id: 'task-nosession', workspaceId: WS_A, sessionId: null },
                { id: 'task-missingfile', workspaceId: WS_A, sessionId: 'session-not-on-disk' }
            );
            writeFileSync(tasksPath, JSON.stringify(raw), 'utf-8');

            await run({ withAgentSessions: true });
            const files = walk(join(out, 'agent-sessions'));
            expect(files).toHaveLength(2);
            expect(files.join('\n')).not.toContain('session-not-on-disk');
        });

        it('rejects a session id that would escape the export directory', async () => {
            const tasksPath = join(dataDir, 'tasks.json');
            const raw = JSON.parse(readFileSync(tasksPath, 'utf-8'));
            raw.data.tasks.push({ id: 'task-evil', workspaceId: WS_A, sessionId: '../../escape' });
            writeFileSync(tasksPath, JSON.stringify(raw), 'utf-8');

            await run({ withAgentSessions: true });
            expect(walk(out).join('\n')).not.toContain('escape');
        });
    });

    // -----------------------------------------------------------------------
    // Never-export list
    // -----------------------------------------------------------------------
    describe('exclusions', () => {
        it('never emits an excluded file, at any tier', async () => {
            await run({ withSecrets: true, withHistories: true, withAgentSessions: true });
            const files = walk(out);

            for (const banned of [
                'instance.json',
                'mcp-token',
                'auth-token',
                'crash.log',
                'session-recovery.json',
                'session-recovery.json.applied',
                'tasks.json.bak',
                'server.pid',
                'scratch.tmp',
            ]) {
                expect(files.some((f) => f.endsWith(banned)), `${banned} was exported`).toBe(false);
            }
        });

        it('never emits the contents of an excluded file', async () => {
            await run({ withSecrets: true, withHistories: true, withAgentSessions: true });
            const everything = readAll(out);

            expect(everything).not.toContain('MCP-TOKEN-SHOULD-NOT-LEAK');
            expect(everything).not.toContain('AUTH-TOKEN-SHOULD-NOT-LEAK');
            expect(everything).not.toContain('CRASH-SHOULD-NOT-LEAK');
            expect(everything).not.toContain('BAK-SHOULD-NOT-LEAK');
            expect(everything).not.toContain('TMP-SHOULD-NOT-LEAK');
            // instance.json's id is recorded as provenance in the manifest, but
            // the file itself is never copied.
            expect(walk(out)).not.toContain('state/instance.json');
        });

        it('skips a .bak or .tmp file that has snuck into a history directory', async () => {
            writeFileSync(join(dataDir, 'task-histories', 'task-live-1.txt.bak'), 'HISTORY-BAK-SHOULD-NOT-LEAK', 'utf-8');
            writeFileSync(join(dataDir, 'task-histories', 'partial.tmp'), 'HISTORY-TMP-SHOULD-NOT-LEAK', 'utf-8');

            await run({ withHistories: true });
            const everything = readAll(out);
            expect(everything).not.toContain('HISTORY-BAK-SHOULD-NOT-LEAK');
            expect(everything).not.toContain('HISTORY-TMP-SHOULD-NOT-LEAK');
        });

        it('records the source instance id as provenance without exporting the file', async () => {
            const manifest = await run();
            expect(manifest.source.instanceId).toBe('instance-should-not-leak');
            expect(walk(out).some((f) => f.endsWith('instance.json') && f !== 'manifest.json')).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // Degenerate inputs
    // -----------------------------------------------------------------------
    describe('robustness', () => {
        it('exports an empty but valid tree from an empty data dir', async () => {
            const emptyDir = join(sandbox, 'empty');
            mkdirSync(emptyDir);
            const manifest = await exportState(emptyDir, { out }, { homeDir: fakeHome });

            expect(manifest.workspaces).toEqual([]);
            expect(manifest.schemaVersions).toEqual({});
            expect(manifest.source.instanceId).toBeNull();
            expect(walk(out)).toEqual(['manifest.json']);
        });

        it('survives a corrupt state file rather than aborting the export', async () => {
            writeFileSync(join(dataDir, 'workspace-config.json'), '{ not json at all', 'utf-8');

            const manifest = await run();
            // Unparseable, so no workspaces can be listed...
            expect(manifest.workspaces).toEqual([]);
            // ...but the bytes are still copied so a human can salvage them,
            // and the rest of the export completes.
            expect(existsSync(join(out, 'state', 'workspace-config.json'))).toBe(true);
            expect(existsSync(join(out, 'state', 'tasks.json'))).toBe(true);
        });

        it('refuses to write into the data directory it is exporting', async () => {
            await expect(exportState(dataDir, { out: join(dataDir, 'nested') }, { homeDir: fakeHome })).rejects.toThrow(
                /inside the data directory/i
            );
        });

        it('requires an output path', async () => {
            await expect(exportState(dataDir, { out: '  ' }, { homeDir: fakeHome })).rejects.toThrow(/out/i);
        });

        it('handles a config.json in the legacy unversioned shape', async () => {
            writeFileSync(
                join(dataDir, 'config.json'),
                JSON.stringify({ apiMode: 'default', customAnthropicApiKey: SECRETS.anthropic, mcpServers: [] }),
                'utf-8'
            );

            const manifest = await run({ withSecrets: true });
            expect(manifest.schemaVersions['config.json']).toBeNull();

            const cfg = JSON.parse(readFileSync(join(out, 'state', 'config.json'), 'utf-8'));
            expect(cfg.customAnthropicApiKey).toBe('');
            expect(cfg.apiMode).toBe('default');
            expect(JSON.parse(readFileSync(join(out, 'secrets.json'), 'utf-8'))['config.json']).toEqual({
                customAnthropicApiKey: SECRETS.anthropic,
            });
        });

        it('omits secrets.json when there is nothing secret to record', async () => {
            writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ apiMode: 'default' }), 'utf-8');

            await run({ withSecrets: true });
            expect(existsSync(join(out, 'secrets.json'))).toBe(false);
        });

        it('reads tasks.json in the legacy unversioned shape for session selection', async () => {
            writeFileSync(
                join(dataDir, 'tasks.json'),
                JSON.stringify({
                    tasks: [{ id: 'task-live-1', workspaceId: WS_A, sessionId: 'session-live-1' }],
                    archivedTasks: [{ id: 'task-archived-1', workspaceId: WS_A, sessionId: 'session-archived-1' }],
                }),
                'utf-8'
            );

            await run({ withAgentSessions: true });
            expect(walk(join(out, 'agent-sessions'))).toEqual([
                `claude-code/${encodeURIComponent(WS_A)}/session-live-1.jsonl`,
            ]);
        });

        it('uses the configured backend name for the session directory', async () => {
            const cfgPath = join(dataDir, 'config.json');
            const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
            raw.data.backend = 'opencode';
            writeFileSync(cfgPath, JSON.stringify(raw), 'utf-8');

            await run({ withAgentSessions: true });
            expect(walk(join(out, 'agent-sessions')).every((f) => f.startsWith('opencode/'))).toBe(true);
        });

        it('creates the output directory tree if it does not exist', async () => {
            const deep = join(sandbox, 'a', 'b', 'c');
            await exportState(dataDir, { out: deep }, { homeDir: fakeHome });
            expect(existsSync(join(deep, 'manifest.json'))).toBe(true);
        });
    });
});


// ===========================================================================
// POST /api/export — the route, booted on an ephemeral port against isolated
// state. Never touches port 4001, and never reads the developer's real data dir.
// ===========================================================================
describe('POST /api/export', () => {
    let h: Harness;
    let outRoot: string;

    beforeEach(async () => {
        h = await startHarness({ prefix: '.claudia-export-route-' });
        seedWorkspaceFile(h.base, [
            { id: '/tmp-fixture/route/alpha', name: 'alpha' },
            { id: '/tmp-fixture/route/beta', name: 'beta', worktreeParentId: '/tmp-fixture/route/alpha' },
        ]);
        seedTasksFile(h.base, [makeTaskRecord('task-route-1', '/tmp-fixture/route/alpha', { sessionId: 's1' })]);
        writeFileSync(
            join(h.base, 'config.json'),
            JSON.stringify({ schemaVersion: 1, data: { customAnthropicApiKey: 'ROUTE-SECRET-KEY', mcpServers: [] } }),
            'utf-8'
        );
        outRoot = mkdtempSync(join(homedir(), '.claudia-export-route-out-'));
    });

    afterEach(async () => {
        await h.stop();
        rmSync(outRoot, { recursive: true, force: true });
    });

    it('exports to the requested directory and returns the manifest', async () => {
        const out = join(outRoot, 'export');
        const { status, body } = await h.send('POST', '/api/export', { out });

        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.manifest.formatVersion).toBe(1);
        expect(body.manifest.workspaces.map((w: { name: string }) => w.name)).toEqual(['alpha', 'beta']);
        expect(body.manifest.tiers).toEqual({ secrets: false, histories: false, agentSessions: false });
        expect(existsSync(join(out, 'manifest.json'))).toBe(true);
        expect(readFileSync(join(out, 'state', 'config.json'), 'utf-8')).not.toContain('ROUTE-SECRET-KEY');
    });

    it('honours the tier flags', async () => {
        const out = join(outRoot, 'tiers');
        const { status, body } = await h.send('POST', '/api/export', {
            out,
            withSecrets: true,
            withHistories: true,
            withAgentSessions: true,
        });

        expect(status).toBe(200);
        expect(body.manifest.tiers).toEqual({ secrets: true, histories: true, agentSessions: true });
        expect(readFileSync(join(out, 'secrets.json'), 'utf-8')).toContain('ROUTE-SECRET-KEY');
    });

    it('rejects a missing or empty out path', async () => {
        for (const payload of [{}, { out: '' }, { out: '   ' }, { out: 42 }]) {
            const { status, body } = await h.send('POST', '/api/export', payload);
            expect(status).toBe(400);
            expect(body.error).toMatch(/out is required/i);
        }
    });

    it('reports a refusal to export into the data directory as an error, not a crash', async () => {
        const { status, body } = await h.send('POST', '/api/export', { out: join(h.base, 'nested') });
        expect(status).toBe(500);
        expect(body.error).toMatch(/inside the data directory/i);
    });
});
