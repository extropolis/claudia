import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { PluginManager } from '../plugin-system/plugin-manager.js';
import type { PluginContext, PluginManifest } from '../plugin-system/plugin-types.js';

/**
 * Tests for src/plugin-system/plugin-manager.ts
 *
 * Uses REAL plugin directories on disk (manifest + ESM entry module) rather
 * than mocks, so discovery, dynamic import and lifecycle are genuinely
 * exercised. The central property under test is ISOLATION: a plugin that is
 * malformed, un-importable, or that throws at any lifecycle point must never
 * take down the manager or its sibling plugins.
 *
 * NOTE: temp dirs live under homedir(), not os.tmpdir() — on macOS tmpdir
 * resolves under /var, which the workspace path validator blocklists.
 */

let BASE: string;

beforeAll(() => {
    BASE = mkdtempSync(join(homedir(), '.claudia-test-plugin-mgr-'));
});

afterAll(() => {
    rmSync(BASE, { recursive: true, force: true });
});

let dirCounter = 0;
/** Fresh, isolated plugin root for one test. */
function newPluginRoot(): string {
    const dir = join(BASE, `root-${dirCounter++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function manifest(over: Partial<PluginManifest> & { name: string }): PluginManifest {
    return {
        version: '1.0.0',
        type: 'utility',
        displayName: `Display ${over.name}`,
        description: 'test plugin',
        backend: { entry: 'index.js', provides: {} },
        ...over,
    } as PluginManifest;
}

/** Write a plugin directory: plugin.json (+ optional entry source). */
function writePlugin(root: string, dirName: string, opts: {
    manifest?: unknown;
    rawManifest?: string;
    entrySource?: string;
    entryFile?: string;
}): string {
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    if (opts.rawManifest !== undefined) {
        writeFileSync(join(dir, 'plugin.json'), opts.rawManifest);
    } else if (opts.manifest !== undefined) {
        writeFileSync(join(dir, 'plugin.json'), JSON.stringify(opts.manifest, null, 2));
    }
    if (opts.entrySource !== undefined) {
        writeFileSync(join(dir, opts.entryFile ?? 'index.js'), opts.entrySource);
    }
    return dir;
}

/**
 * Source for a well-behaved plugin. Records lifecycle calls on a global keyed
 * by name so the test can observe them across the dynamic-import boundary.
 */
function goodPluginSource(name: string, extra = ''): string {
    return `
globalThis.__pluginCalls = globalThis.__pluginCalls || {};
globalThis.__pluginCalls[${JSON.stringify(name)}] = [];
export default class Plugin {
    async initialize(ctx) {
        globalThis.__pluginCalls[${JSON.stringify(name)}].push('initialize');
        this.ctx = ctx;
    }
    async shutdown() {
        globalThis.__pluginCalls[${JSON.stringify(name)}].push('shutdown');
    }
    ${extra}
}
`;
}

function calls(name: string): string[] {
    return ((globalThis as any).__pluginCalls?.[name]) ?? [];
}

interface FakeStore {
    isPluginEnabled: (n: string) => boolean;
    getApiMode: () => string;
}

function makeContext(over: Partial<FakeStore> = {}): PluginContext {
    const store: FakeStore = {
        isPluginEnabled: () => true,
        getApiMode: () => 'anthropic',
        ...over,
    };
    return {
        configStore: store as any,
        logger: console,
        express: {} as any,
        utils: { spawn: (() => { }) as any, fetch: globalThis.fetch },
    };
}

describe('plugin-manager', () => {
    beforeEach(() => {
        (globalThis as any).__pluginCalls = {};
        vi.spyOn(console, 'log').mockImplementation(() => { });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        vi.spyOn(console, 'error').mockImplementation(() => { });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('discoverPlugins', () => {
        it('is a no-op for a directory that does not exist', async () => {
            const mgr = new PluginManager(makeContext());
            await expect(mgr.discoverPlugins(join(BASE, 'does-not-exist'))).resolves.toBeUndefined();
            expect(mgr.getPlugins().size).toBe(0);
        });

        it('loads a well-formed plugin and calls initialize with the context', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'alpha', {
                manifest: manifest({ name: 'alpha' }),
                entrySource: goodPluginSource('alpha'),
            });

            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);

            expect(mgr.getPlugins().size).toBe(1);
            expect(mgr.getPlugin('alpha')).toBeDefined();
            expect(mgr.getPlugin('alpha')!.manifest.displayName).toBe('Display alpha');
            expect(calls('alpha')).toEqual(['initialize']);
        });

        it('loads several plugins from one directory', async () => {
            const root = newPluginRoot();
            for (const n of ['one', 'two', 'three']) {
                writePlugin(root, n, { manifest: manifest({ name: n }), entrySource: goodPluginSource(n) });
            }
            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);
            expect([...mgr.getPlugins().keys()].sort()).toEqual(['one', 'three', 'two']);
        });

        it('ignores loose files and directories without a plugin.json', async () => {
            const root = newPluginRoot();
            writeFileSync(join(root, 'README.md'), 'not a plugin');
            writeFileSync(join(root, 'plugin.json'), '{"name":"top-level-should-be-ignored"}');
            mkdirSync(join(root, 'empty-dir'));
            writePlugin(root, 'real', { manifest: manifest({ name: 'real' }), entrySource: goodPluginSource('real') });

            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);
            expect([...mgr.getPlugins().keys()]).toEqual(['real']);
        });

        it('survives a plugin path that exists but is a file, not a directory', async () => {
            const notADir = join(BASE, 'a-file-not-a-dir');
            writeFileSync(notADir, 'x');
            const mgr = new PluginManager(makeContext());
            // existsSync passes, readdirSync throws ENOTDIR — must be caught.
            await expect(mgr.discoverPlugins(notADir)).resolves.toBeUndefined();
            expect(mgr.getPlugins().size).toBe(0);
        });

        it('loads nothing from an empty directory without throwing', async () => {
            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(newPluginRoot());
            expect(mgr.getPlugins().size).toBe(0);
        });
    });

    describe('malformed manifests are rejected without crashing', () => {
        it('survives invalid JSON in plugin.json', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'broken', { rawManifest: '{ this is not json', entrySource: goodPluginSource('broken') });
            const mgr = new PluginManager(makeContext());
            await expect(mgr.discoverPlugins(root)).resolves.toBeUndefined();
            expect(mgr.getPlugins().size).toBe(0);
        });

        it.each([
            ['missing name', { version: '1.0.0', displayName: 'X', type: 'utility', backend: { entry: 'index.js', provides: {} } }],
            ['missing version', { name: 'x', displayName: 'X', type: 'utility', backend: { entry: 'index.js', provides: {} } }],
            ['missing displayName', { name: 'x', version: '1.0.0', type: 'utility', backend: { entry: 'index.js', provides: {} } }],
            ['empty object', {}],
        ])('rejects a manifest that is %s', async (_label, bad) => {
            const root = newPluginRoot();
            writePlugin(root, 'bad', { manifest: bad, entrySource: goodPluginSource('bad') });
            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);
            expect(mgr.getPlugins().size).toBe(0);
        });

        it('skips a plugin declaring no backend entry', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'frontend-only', {
                manifest: { name: 'fo', version: '1.0.0', type: 'utility', displayName: 'FO', description: '' },
            });
            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);
            expect(mgr.getPlugins().size).toBe(0);
        });

        it('survives a manifest whose entry file does not exist', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'ghost', { manifest: manifest({ name: 'ghost' }) }); // no index.js
            const mgr = new PluginManager(makeContext());
            await expect(mgr.discoverPlugins(root)).resolves.toBeUndefined();
            expect(mgr.getPlugins().size).toBe(0);
        });
    });

    describe('ISOLATION: one bad plugin must not take down the others', () => {
        it('loads healthy siblings around a manifest with invalid JSON', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'a-good', { manifest: manifest({ name: 'a-good' }), entrySource: goodPluginSource('a-good') });
            writePlugin(root, 'b-broken-json', { rawManifest: '{{{ nope', entrySource: goodPluginSource('b') });
            writePlugin(root, 'c-good', { manifest: manifest({ name: 'c-good' }), entrySource: goodPluginSource('c-good') });

            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);

            expect([...mgr.getPlugins().keys()].sort()).toEqual(['a-good', 'c-good']);
            expect(calls('a-good')).toEqual(['initialize']);
            expect(calls('c-good')).toEqual(['initialize']);
        });

        it('loads healthy siblings around an entry module that throws at import time', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'a-good', { manifest: manifest({ name: 'a-good' }), entrySource: goodPluginSource('a-good') });
            writePlugin(root, 'b-throws-on-import', {
                manifest: manifest({ name: 'b-throws' }),
                entrySource: `throw new Error('exploding module');\nexport default class P {}\n`,
            });
            writePlugin(root, 'c-good', { manifest: manifest({ name: 'c-good' }), entrySource: goodPluginSource('c-good') });

            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);

            expect([...mgr.getPlugins().keys()].sort()).toEqual(['a-good', 'c-good']);
        });

        it('loads healthy siblings around an entry module with a syntax error', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'a-good', { manifest: manifest({ name: 'a-good' }), entrySource: goodPluginSource('a-good') });
            writePlugin(root, 'b-syntax-error', {
                manifest: manifest({ name: 'b-syntax' }),
                entrySource: 'export default class { function( ===',
            });
            writePlugin(root, 'c-good', { manifest: manifest({ name: 'c-good' }), entrySource: goodPluginSource('c-good') });

            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);

            expect([...mgr.getPlugins().keys()].sort()).toEqual(['a-good', 'c-good']);
        });

        it('loads healthy siblings around a constructor that throws', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'a-good', { manifest: manifest({ name: 'a-good' }), entrySource: goodPluginSource('a-good') });
            writePlugin(root, 'b-bad-ctor', {
                manifest: manifest({ name: 'b-ctor' }),
                entrySource: `export default class P { constructor() { throw new Error('ctor blew up'); } }\n`,
            });
            writePlugin(root, 'c-good', { manifest: manifest({ name: 'c-good' }), entrySource: goodPluginSource('c-good') });

            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);

            expect([...mgr.getPlugins().keys()].sort()).toEqual(['a-good', 'c-good']);
            expect(mgr.getPlugin('b-ctor')).toBeUndefined();
        });

        it('loads healthy siblings around an initialize() that rejects', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'a-good', { manifest: manifest({ name: 'a-good' }), entrySource: goodPluginSource('a-good') });
            writePlugin(root, 'b-bad-init', {
                manifest: manifest({ name: 'b-init' }),
                entrySource: `export default class P { async initialize() { throw new Error('init failed'); } }\n`,
            });
            writePlugin(root, 'c-good', { manifest: manifest({ name: 'c-good' }), entrySource: goodPluginSource('c-good') });

            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);

            // The failed plugin is NOT registered — the map only ever contains
            // plugins that completed initialize().
            expect([...mgr.getPlugins().keys()].sort()).toEqual(['a-good', 'c-good']);
            expect(mgr.getPlugin('b-init')).toBeUndefined();
        });

        it('keeps working after a bad plugin — later loads still succeed', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'bad', { rawManifest: 'not json at all' });
            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);
            expect(mgr.getPlugins().size).toBe(0);

            const later = writePlugin(root, 'later', {
                manifest: manifest({ name: 'later' }),
                entrySource: goodPluginSource('later'),
            });
            await mgr.loadPlugin(later);
            expect(mgr.getPlugin('later')).toBeDefined();
        });
    });

    describe('enable / disable', () => {
        it('skips a plugin the config store reports as disabled', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'off', { manifest: manifest({ name: 'off' }), entrySource: goodPluginSource('off') });

            const mgr = new PluginManager(makeContext({ isPluginEnabled: () => false }));
            await mgr.discoverPlugins(root);

            expect(mgr.getPlugins().size).toBe(0);
            expect(calls('off')).toEqual([]); // initialize never ran
        });

        it('loads only the enabled subset', async () => {
            const root = newPluginRoot();
            for (const n of ['keep', 'drop']) {
                writePlugin(root, n, { manifest: manifest({ name: n }), entrySource: goodPluginSource(n) });
            }
            const mgr = new PluginManager(makeContext({ isPluginEnabled: (n) => n === 'keep' }));
            await mgr.discoverPlugins(root);
            expect([...mgr.getPlugins().keys()]).toEqual(['keep']);
        });

        it('re-enabling then re-discovering loads the plugin', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'toggle', { manifest: manifest({ name: 'toggle' }), entrySource: goodPluginSource('toggle') });

            let enabled = false;
            const mgr = new PluginManager(makeContext({ isPluginEnabled: () => enabled }));
            await mgr.discoverPlugins(root);
            expect(mgr.getPlugins().size).toBe(0);

            enabled = true;
            await mgr.discoverPlugins(root);
            expect(mgr.getPlugins().size).toBe(1);
        });

        it('does not double-register an already-loaded plugin', async () => {
            const root = newPluginRoot();
            const dir = writePlugin(root, 'once', { manifest: manifest({ name: 'once' }), entrySource: goodPluginSource('once') });
            const mgr = new PluginManager(makeContext());
            await mgr.loadPlugin(dir);
            const first = mgr.getPlugin('once');
            await mgr.loadPlugin(dir);
            expect(mgr.getPlugins().size).toBe(1);
            expect(mgr.getPlugin('once')).toBe(first);
        });
    });

    describe('lookup and metadata', () => {
        async function loadFixture() {
            const root = newPluginRoot();
            writePlugin(root, 'provider', {
                manifest: manifest({
                    name: 'provider',
                    type: 'ai-provider',
                    author: 'Tester',
                    backend: {
                        entry: 'index.js',
                        provides: {
                            apiMode: 'custom-mode',
                            models: [{ id: 'm1', name: 'Model One', tier: 'sonnet' }],
                            configSchema: { apiKey: { type: 'string', required: true, secret: true } },
                        },
                    },
                    frontend: { settingsComponent: 'Settings.tsx' },
                }),
                entrySource: goodPluginSource('provider'),
            });
            writePlugin(root, 'plain', { manifest: manifest({ name: 'plain' }), entrySource: goodPluginSource('plain') });
            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);
            return { mgr, root };
        }

        it('getPlugin returns undefined for an unknown name', async () => {
            const { mgr } = await loadFixture();
            expect(mgr.getPlugin('nope')).toBeUndefined();
        });

        it('getPluginByApiMode finds the matching provider', async () => {
            const { mgr } = await loadFixture();
            expect(mgr.getPluginByApiMode('custom-mode')?.manifest.name).toBe('provider');
        });

        it('getPluginByApiMode returns undefined for an unmatched mode', async () => {
            const { mgr } = await loadFixture();
            expect(mgr.getPluginByApiMode('no-such-mode')).toBeUndefined();
        });

        it('getPluginMetadata reports every loaded plugin as enabled', async () => {
            const { mgr } = await loadFixture();
            const meta = mgr.getPluginMetadata();
            expect(meta).toHaveLength(2);
            const provider = meta.find((m) => m.name === 'provider')!;
            expect(provider).toMatchObject({
                version: '1.0.0',
                type: 'ai-provider',
                displayName: 'Display provider',
                author: 'Tester',
                apiMode: 'custom-mode',
                hasSettingsUI: true,
                enabled: true,
            });
            expect(provider.models).toEqual([{ id: 'm1', name: 'Model One', tier: 'sonnet' }]);
            expect(meta.find((m) => m.name === 'plain')!.hasSettingsUI).toBe(false);
        });

        it('getPluginMetadata is empty before anything is loaded', () => {
            expect(new PluginManager(makeContext()).getPluginMetadata()).toEqual([]);
        });
    });

    describe('getAllAvailablePlugins', () => {
        it('returns [] for a directory that does not exist', () => {
            const mgr = new PluginManager(makeContext());
            expect(mgr.getAllAvailablePlugins(join(BASE, 'nowhere'))).toEqual([]);
        });

        it('lists disabled plugins too, with the correct enabled flag', () => {
            const root = newPluginRoot();
            writePlugin(root, 'on', { manifest: manifest({ name: 'on' }), entrySource: goodPluginSource('on') });
            writePlugin(root, 'off', { manifest: manifest({ name: 'off' }), entrySource: goodPluginSource('off') });

            const mgr = new PluginManager(makeContext({ isPluginEnabled: (n) => n === 'on' }));
            const all = mgr.getAllAvailablePlugins(root);

            expect(all.map((m) => [m.name, m.enabled]).sort()).toEqual([['off', false], ['on', true]]);
        });

        it('skips a malformed manifest but still lists the healthy ones', () => {
            const root = newPluginRoot();
            writePlugin(root, 'a-good', { manifest: manifest({ name: 'a-good' }) });
            writePlugin(root, 'b-broken', { rawManifest: 'definitely not json' });
            writePlugin(root, 'c-good', { manifest: manifest({ name: 'c-good' }) });

            const mgr = new PluginManager(makeContext());
            const all = mgr.getAllAvailablePlugins(root);
            expect(all.map((m) => m.name).sort()).toEqual(['a-good', 'c-good']);
        });

        it('ignores non-directory entries and directories without a manifest', () => {
            const root = newPluginRoot();
            writeFileSync(join(root, 'stray.txt'), 'x');
            mkdirSync(join(root, 'no-manifest'));
            writePlugin(root, 'real', { manifest: manifest({ name: 'real' }) });

            expect(new PluginManager(makeContext()).getAllAvailablePlugins(root).map((m) => m.name))
                .toEqual(['real']);
        });

        it('returns [] when the path exists but is a file, not a directory', () => {
            const notADir = join(BASE, 'available-not-a-dir');
            writeFileSync(notADir, 'x');
            expect(new PluginManager(makeContext()).getAllAvailablePlugins(notADir)).toEqual([]);
        });

        it('does not require the plugin to be loaded first', () => {
            const root = newPluginRoot();
            writePlugin(root, 'unloaded', { manifest: manifest({ name: 'unloaded' }) });
            const mgr = new PluginManager(makeContext());
            expect(mgr.getPlugins().size).toBe(0);
            expect(mgr.getAllAvailablePlugins(root)).toHaveLength(1);
        });
    });

    describe('registerRoutes', () => {
        function fakeApp() {
            const mounts: Array<[string, unknown]> = [];
            return { mounts, use: (path: string, router: unknown) => { mounts.push([path, router]); } };
        }

        async function managerWith(sources: Array<{ dir: string; manifest: PluginManifest; source: string }>, ctxOver: Partial<FakeStore> = {}) {
            const root = newPluginRoot();
            for (const s of sources) writePlugin(root, s.dir, { manifest: s.manifest, entrySource: s.source });
            const mgr = new PluginManager(makeContext(ctxOver));
            await mgr.discoverPlugins(root);
            return mgr;
        }

        const routerSource = (name: string) => goodPluginSource(name, `
    getRouter() { return { __router: ${JSON.stringify(name)} }; }
`);

        it('mounts a matching ai-provider at /v1, /anthropic and /plugins/<name>', async () => {
            const mgr = await managerWith([{
                dir: 'prov',
                manifest: manifest({ name: 'prov', type: 'ai-provider', backend: { entry: 'index.js', provides: { apiMode: 'anthropic' } } }),
                source: routerSource('prov'),
            }]);

            const app = fakeApp();
            mgr.registerRoutes(app as any);
            expect(app.mounts.map((m) => m[0])).toEqual(['/v1', '/anthropic', '/plugins/prov']);
        });

        it('does not mount an ai-provider whose apiMode differs from the active one', async () => {
            const mgr = await managerWith([{
                dir: 'other',
                manifest: manifest({ name: 'other', type: 'ai-provider', backend: { entry: 'index.js', provides: { apiMode: 'zai' } } }),
                source: routerSource('other'),
            }], { getApiMode: () => 'anthropic' });

            const app = fakeApp();
            mgr.registerRoutes(app as any);
            expect(app.mounts.map((m) => m[0])).toEqual(['/plugins/other']);
        });

        it('skips plugins that expose no router', async () => {
            const mgr = await managerWith([
                { dir: 'norouter', manifest: manifest({ name: 'norouter' }), source: goodPluginSource('norouter') },
            ]);
            const app = fakeApp();
            mgr.registerRoutes(app as any);
            expect(app.mounts).toEqual([]);
        });

        it('ISOLATION: a getRouter() that throws does not stop the other plugins mounting', async () => {
            const mgr = await managerWith([
                { dir: 'a-ok', manifest: manifest({ name: 'a-ok' }), source: routerSource('a-ok') },
                {
                    dir: 'b-bad', manifest: manifest({ name: 'b-bad' }),
                    source: goodPluginSource('b-bad', `getRouter() { throw new Error('router blew up'); }`),
                },
                { dir: 'c-ok', manifest: manifest({ name: 'c-ok' }), source: routerSource('c-ok') },
            ]);

            const app = fakeApp();
            expect(() => mgr.registerRoutes(app as any)).not.toThrow();
            expect(app.mounts.map((m) => m[0]).sort()).toEqual(['/plugins/a-ok', '/plugins/c-ok']);
        });

        it('ISOLATION: an ai-provider whose getRouter() throws still lets others mount', async () => {
            const mgr = await managerWith([
                {
                    dir: 'a-bad-provider',
                    manifest: manifest({ name: 'a-bad-provider', type: 'ai-provider', backend: { entry: 'index.js', provides: { apiMode: 'anthropic' } } }),
                    source: goodPluginSource('a-bad-provider', `getRouter() { throw new Error('provider router boom'); }`),
                },
                { dir: 'b-ok', manifest: manifest({ name: 'b-ok' }), source: routerSource('b-ok') },
            ]);

            const app = fakeApp();
            expect(() => mgr.registerRoutes(app as any)).not.toThrow();
            // Neither /v1 nor /anthropic gets mounted for the broken provider,
            // but the healthy plugin still mounts under /plugins.
            expect(app.mounts.map((m) => m[0])).toEqual(['/plugins/b-ok']);
        });

        it('is a no-op when nothing is loaded', () => {
            const app = fakeApp();
            new PluginManager(makeContext()).registerRoutes(app as any);
            expect(app.mounts).toEqual([]);
        });
    });

    describe('delegating helpers', () => {
        async function loadProvider(body: string) {
            const root = newPluginRoot();
            writePlugin(root, 'p', {
                manifest: manifest({ name: 'p', type: 'ai-provider', backend: { entry: 'index.js', provides: { apiMode: 'mode-x' } } }),
                entrySource: `export default class P {\n${body}\n}\n`,
            });
            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);
            expect(mgr.getPlugins().size).toBe(1);
            return mgr;
        }

        describe('getTaskEnvironment', () => {
            it('returns the plugin-provided environment', async () => {
                const mgr = await loadProvider(`getTaskEnvironment(cfg) { return { TOKEN: String(cfg.token) }; }`);
                expect(mgr.getTaskEnvironment('mode-x', { token: 'abc' })).toEqual({ TOKEN: 'abc' });
            });

            it('returns {} when no plugin serves the api mode', async () => {
                const mgr = await loadProvider(`getTaskEnvironment() { return { A: '1' }; }`);
                expect(mgr.getTaskEnvironment('unknown-mode', {})).toEqual({});
            });

            it('ISOLATION: returns {} when the plugin throws', async () => {
                const mgr = await loadProvider(`getTaskEnvironment() { throw new Error('env boom'); }`);
                expect(mgr.getTaskEnvironment('mode-x', {})).toEqual({});
            });

            it('returns {} when the plugin does not implement it', async () => {
                const mgr = await loadProvider('');
                expect(mgr.getTaskEnvironment('mode-x', {})).toEqual({});
            });
        });

        describe('validatePluginConfig', () => {
            it('passes the plugin verdict through', async () => {
                const mgr = await loadProvider(`validateConfig(cfg) { return cfg.ok ? { valid: true } : { valid: false, error: 'missing ok' }; }`);
                expect(mgr.validatePluginConfig('mode-x', { ok: true })).toEqual({ valid: true });
                expect(mgr.validatePluginConfig('mode-x', {})).toEqual({ valid: false, error: 'missing ok' });
            });

            it('ISOLATION: converts a thrown Error into {valid:false,error}', async () => {
                const mgr = await loadProvider(`validateConfig() { throw new Error('validator exploded'); }`);
                expect(mgr.validatePluginConfig('mode-x', {})).toEqual({ valid: false, error: 'validator exploded' });
            });

            it('stringifies a non-Error throw', async () => {
                const mgr = await loadProvider(`validateConfig() { throw 'plain string'; }`);
                expect(mgr.validatePluginConfig('mode-x', {})).toEqual({ valid: false, error: 'plain string' });
            });

            it('defaults to valid when no plugin serves the mode', async () => {
                const mgr = await loadProvider(`validateConfig() { return { valid: false }; }`);
                expect(mgr.validatePluginConfig('other-mode', {})).toEqual({ valid: true });
            });

            it('defaults to valid when the plugin has no validator', async () => {
                const mgr = await loadProvider('');
                expect(mgr.validatePluginConfig('mode-x', {})).toEqual({ valid: true });
            });
        });

        describe('testPluginConnection', () => {
            it('passes a successful result through', async () => {
                const mgr = await loadProvider(`async testConnection() { return { success: true }; }`);
                await expect(mgr.testPluginConnection('mode-x', {})).resolves.toEqual({ success: true });
            });

            it('ISOLATION: converts a rejection into {success:false,error}', async () => {
                const mgr = await loadProvider(`async testConnection() { throw new Error('connect failed'); }`);
                await expect(mgr.testPluginConnection('mode-x', {})).resolves.toEqual({
                    success: false, error: 'connect failed',
                });
            });

            it('stringifies a non-Error rejection', async () => {
                const mgr = await loadProvider(`async testConnection() { throw { code: 42 }; }`);
                const r = await mgr.testPluginConnection('mode-x', {});
                expect(r.success).toBe(false);
                expect(r.error).toBe('[object Object]');
            });

            it('reports unsupported when no plugin serves the mode', async () => {
                const mgr = await loadProvider(`async testConnection() { return { success: true }; }`);
                await expect(mgr.testPluginConnection('nope', {})).resolves.toEqual({
                    success: false, error: 'Plugin does not support connection testing',
                });
            });

            it('reports unsupported when the plugin lacks testConnection', async () => {
                const mgr = await loadProvider('');
                await expect(mgr.testPluginConnection('mode-x', {})).resolves.toEqual({
                    success: false, error: 'Plugin does not support connection testing',
                });
            });
        });

        describe('notifyConfigChange', () => {
            it('forwards the config to the matching plugin', async () => {
                const mgr = await loadProvider(`async onConfigChange(cfg) { globalThis.__cfgSeen = cfg; }`);
                await mgr.notifyConfigChange('mode-x', { a: 1 });
                expect((globalThis as any).__cfgSeen).toEqual({ a: 1 });
                delete (globalThis as any).__cfgSeen;
            });

            it('ISOLATION: swallows a rejection from the plugin', async () => {
                const mgr = await loadProvider(`async onConfigChange() { throw new Error('notify boom'); }`);
                await expect(mgr.notifyConfigChange('mode-x', {})).resolves.toBeUndefined();
            });

            it('is a no-op for an unmatched api mode', async () => {
                const mgr = await loadProvider(`async onConfigChange() { throw new Error('should not run'); }`);
                await expect(mgr.notifyConfigChange('other', {})).resolves.toBeUndefined();
            });

            it('is a no-op when the plugin has no handler', async () => {
                const mgr = await loadProvider('');
                await expect(mgr.notifyConfigChange('mode-x', {})).resolves.toBeUndefined();
            });
        });
    });

    describe('shutdown', () => {
        it('calls shutdown on every plugin and clears the registry', async () => {
            const root = newPluginRoot();
            for (const n of ['s1', 's2']) {
                writePlugin(root, n, { manifest: manifest({ name: n }), entrySource: goodPluginSource(n) });
            }
            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);
            await mgr.shutdown();

            expect(calls('s1')).toEqual(['initialize', 'shutdown']);
            expect(calls('s2')).toEqual(['initialize', 'shutdown']);
            expect(mgr.getPlugins().size).toBe(0);
        });

        it('ISOLATION: a plugin whose shutdown throws does not block the others', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'a-ok', { manifest: manifest({ name: 'a-ok' }), entrySource: goodPluginSource('a-ok') });
            writePlugin(root, 'b-bad', {
                manifest: manifest({ name: 'b-bad' }),
                entrySource: `export default class P { async shutdown() { throw new Error('shutdown boom'); } }\n`,
            });
            writePlugin(root, 'c-ok', { manifest: manifest({ name: 'c-ok' }), entrySource: goodPluginSource('c-ok') });

            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);
            expect(mgr.getPlugins().size).toBe(3);

            await expect(mgr.shutdown()).resolves.toBeUndefined();
            expect(calls('a-ok')).toContain('shutdown');
            expect(calls('c-ok')).toContain('shutdown');
            expect(mgr.getPlugins().size).toBe(0);
        });

        it('tolerates plugins without a shutdown hook', async () => {
            const root = newPluginRoot();
            writePlugin(root, 'nohook', {
                manifest: manifest({ name: 'nohook' }),
                entrySource: `export default class P {}\n`,
            });
            const mgr = new PluginManager(makeContext());
            await mgr.discoverPlugins(root);
            await expect(mgr.shutdown()).resolves.toBeUndefined();
            expect(mgr.getPlugins().size).toBe(0);
        });

        it('is safe to call twice', async () => {
            const mgr = new PluginManager(makeContext());
            await mgr.shutdown();
            await expect(mgr.shutdown()).resolves.toBeUndefined();
        });

        it('allows reloading a plugin after shutdown', async () => {
            const root = newPluginRoot();
            const dir = writePlugin(root, 'again', { manifest: manifest({ name: 'again' }), entrySource: goodPluginSource('again') });
            const mgr = new PluginManager(makeContext());
            await mgr.loadPlugin(dir);
            await mgr.shutdown();
            await mgr.loadPlugin(dir);
            expect(mgr.getPlugin('again')).toBeDefined();
        });
    });
});
