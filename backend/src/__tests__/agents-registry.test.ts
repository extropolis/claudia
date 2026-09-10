/**
 * The agent registry is the seam that replaced six independently hand-written
 * copies of the agent list. These tests pin the two properties that make that
 * safe: an unknown id FAILS LOUDLY (naming what is registered) instead of
 * silently resolving to undefined, and every registered adapter carries a
 * COMPLETE capability descriptor — the thing that turns "we forgot to add the
 * new agent to this `if`" from a runtime omission into a caught error.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AGENT_IDS, type AgentCapabilities, type AgentId } from '@claudia/shared';
import {
    DEFAULT_AGENT_ID,
    __resetAgentRegistryForTests,
    createClaudeCodeAdapter,
    createOpenCodeAdapter,
    getAgent,
    getAgentCapabilities,
    getAgentDisplay,
    getOpencodePort,
    hasAgent,
    listAgentDisplays,
    listAgentIds,
    listAgents,
    registerAgent,
    resolveAgentCapabilities,
    setOpencodePortProvider,
} from '../agents/index.js';
import type { AgentAdapter } from '../agents/index.js';

/** Re-register the built-ins after a test has cleared or extended the registry. */
function restoreBuiltIns(): void {
    __resetAgentRegistryForTests();
    registerAgent(createClaudeCodeAdapter());
    registerAgent(createOpenCodeAdapter({ getPort: () => 4096 }));
}

const CAPABILITY_KEYS: Array<keyof AgentCapabilities> = [
    'ptyStatePolling',
    'sessionFileCapture',
    'idleReaper',
    'memoryGuard',
    'interactiveApprovals',
    'resumeRequiresSessionFile',
    'supportsSystemPromptFlag',
    'transport',
    'expectedMemoryMb',
];

afterEach(() => {
    restoreBuiltIns();
    vi.restoreAllMocks();
});

describe('agent registry — built-ins', () => {
    it('registers exactly the agents AGENT_IDS declares, in that order', () => {
        expect(listAgentIds()).toEqual([...AGENT_IDS]);
    });

    it('resolves each declared id to an adapter whose id matches', () => {
        for (const id of AGENT_IDS) {
            expect(getAgent(id).id).toBe(id);
        }
    });

    it('exposes display info in registry order', () => {
        expect(listAgentDisplays().map(d => d.id)).toEqual([...AGENT_IDS]);
        expect(getAgentDisplay('claude-code').name).toBe('Claude Code');
        expect(getAgentDisplay('opencode').name).toBe('OpenCode');
    });

    it('hasAgent answers for both known and unknown ids', () => {
        expect(hasAgent('claude-code')).toBe(true);
        expect(hasAgent('codex')).toBe(false);
    });

    it('the default agent is registered', () => {
        expect(hasAgent(DEFAULT_AGENT_ID)).toBe(true);
    });
});

describe('agent registry — unknown ids', () => {
    it('getAgent throws and names the registered ids', () => {
        expect(() => getAgent('codex' as AgentId)).toThrowError(/Unknown agent id "codex"/);
        expect(() => getAgent('codex' as AgentId)).toThrowError(/claude-code, opencode/);
    });

    it('getAgentCapabilities and getAgentDisplay inherit the strict lookup', () => {
        expect(() => getAgentCapabilities('nope' as AgentId)).toThrow();
        expect(() => getAgentDisplay('nope' as AgentId)).toThrow();
    });

    it('the error still reads sensibly when nothing is registered', () => {
        __resetAgentRegistryForTests();
        expect(() => getAgent('claude-code')).toThrowError(/<none registered>/);
    });

    it('resolveAgentCapabilities degrades to the default agent instead of throwing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Persisted data — a hand-edited config.json, or a task written by a
        // newer build — must never crash the spawner on boot.
        expect(resolveAgentCapabilities('codex')).toEqual(getAgentCapabilities(DEFAULT_AGENT_ID));
        expect(resolveAgentCapabilities(undefined)).toEqual(getAgentCapabilities(DEFAULT_AGENT_ID));
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('resolveAgentCapabilities returns the real descriptor for a known id', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(resolveAgentCapabilities('opencode').ptyStatePolling).toBe(false);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('every registered adapter is complete', () => {
    it('declares every capability field — no partial descriptors', () => {
        for (const adapter of listAgents()) {
            for (const key of CAPABILITY_KEYS) {
                expect(
                    adapter.capabilities[key],
                    `${adapter.id} is missing capability "${key}"`,
                ).toBeDefined();
            }
            expect(['pty', 'json-stream']).toContain(adapter.capabilities.transport);
            expect(adapter.capabilities.expectedMemoryMb).toBeGreaterThan(0);
        }
    });

    it('has a short, lowercase task-row badge label', () => {
        for (const adapter of listAgents()) {
            const { shortLabel } = adapter.display;
            // The badge sits in a dense sidebar next to the worktree/PR/#num
            // badges — a glance-level identifier, never a product name.
            expect(shortLabel).toBe(shortLabel.toLowerCase());
            expect(shortLabel.length).toBeGreaterThan(0);
            expect(shortLabel.length).toBeLessThanOrEqual(8);
            expect(shortLabel).not.toMatch(/\s/);
        }
    });

    it('has display metadata Settings can render without hardcoding anything', () => {
        for (const adapter of listAgents()) {
            const d = adapter.display;
            expect(d.id).toBe(adapter.id);
            expect(d.name.length).toBeGreaterThan(0);
            expect(d.description.length).toBeGreaterThan(0);
            expect(d.installUrl).toMatch(/^https:\/\//);
            expect(d.colour).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });

    it('implements the seam methods this slice covers', () => {
        for (const adapter of listAgents()) {
            expect(typeof adapter.detect).toBe('function');
            expect(typeof adapter.resolveExecutable).toBe('function');
            expect(typeof adapter.buildSpawnArgs).toBe('function');
            expect(typeof adapter.buildResumeArgs).toBe('function');
        }
    });

    it('injectMcp is a clearly-labelled stub, not a silent no-op', () => {
        for (const adapter of listAgents()) {
            expect(() => adapter.injectMcp({ taskId: 't', workspaceId: 'w', mcpConfig: {} }))
                .toThrowError(/not implemented on the adapter seam yet/);
        }
    });
});

describe('the OpenCode port provider', () => {
    // The registry loads at import time, long before the config store is
    // constructed, so the OpenCode health-probe port arrives through a
    // provider the server installs at startup rather than a constructor
    // argument. `index.ts` passes `getOpencodePort` itself to the adapter, so
    // whatever this returns is what the next detect() probes.
    it('defaults to the config-store default until the server installs one', () => {
        expect(getOpencodePort()).toBe(4096);
    });

    it('follows the installed provider, re-read on every call', async () => {
        let configured = 4242;
        setOpencodePortProvider(() => configured);
        try {
            expect(getOpencodePort()).toBe(4242);

            const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
            const probe = createOpenCodeAdapter({
                getPort: getOpencodePort,
                execSync: () => 'opencode 0.4.2',
                fetch: fetchMock as unknown as typeof fetch,
            });

            await probe.detect();
            configured = 5555;
            await probe.detect();

            expect(String(fetchMock.mock.calls[0][0])).toContain(':4242/global/health');
            expect(String(fetchMock.mock.calls[1][0])).toContain(':5555/global/health');
        } finally {
            setOpencodePortProvider(() => 4096);
        }
    });
});

describe('adding an agent is one registry entry', () => {
    /** Stand-in for the future Codex adapter. */
    const fakeAgent: AgentAdapter = {
        id: 'codex' as AgentId,
        display: {
            id: 'codex' as AgentId,
            name: 'GPT Codex',
            shortLabel: 'gpt',
            description: 'OpenAI coding agent',
            installUrl: 'https://example.invalid',
            colour: '#10a37f',
        },
        capabilities: {
            ptyStatePolling: false,
            sessionFileCapture: true,
            idleReaper: true,
            memoryGuard: true,
            interactiveApprovals: false,
            resumeRequiresSessionFile: false,
            supportsSystemPromptFlag: false,
            transport: 'json-stream',
            expectedMemoryMb: 120,
        },
        detect: async () => ({ installed: true, version: '0.153.4' }),
        resolveExecutable: () => ({ command: 'codex', prefixArgs: [] }),
        buildSpawnArgs: c => ({ argv: ['exec', '--json'], env: c.env, cwd: c.cwd }),
        buildResumeArgs: (sid, c) => ({ argv: ['exec', 'resume', sid ?? ''], env: c.env, cwd: c.cwd }),
        injectMcp: () => ({ argv: [], env: {}, files: [] }),
    };

    it('a newly registered agent is visible to every consumer at once', () => {
        registerAgent(fakeAgent);

        expect(hasAgent('codex')).toBe(true);
        expect(getAgent('codex' as AgentId)).toBe(fakeAgent);
        expect(getAgentCapabilities('codex' as AgentId).transport).toBe('json-stream');
        expect(listAgentDisplays().map(d => d.shortLabel)).toContain('gpt');
        // Declared agents keep their AGENT_IDS order; an id AGENT_IDS does not
        // know about yet is appended rather than dropped.
        expect(listAgentIds()).toEqual([...AGENT_IDS, 'codex']);
    });

    it('registering the same id twice replaces rather than duplicates', () => {
        registerAgent(fakeAgent);
        registerAgent({ ...fakeAgent, display: { ...fakeAgent.display, name: 'Codex v2' } });
        expect(listAgentIds().filter(id => (id as string) === 'codex')).toHaveLength(1);
        expect(getAgentDisplay('codex' as AgentId).name).toBe('Codex v2');
    });
});
