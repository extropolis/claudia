/**
 * The backend registry seam (`backends/index.ts`): `createBackend()` is the
 * only place TaskSpawner names a concrete implementation, so every registered
 * BackendType must resolve to an instance that satisfies the CodeBackend
 * contract, and an unknown type must degrade to the default rather than throw.
 */
import { describe, it, expect } from 'vitest';
import { createBackend, ClaudeCodeBackend, OpenCodeBackend, BACKEND_INFO } from '../backends/index.js';
import type { BackendType, CodeBackend } from '../backends/index.js';
import { AGENT_IDS } from '@claudia/shared';
import { listAgentIds } from '../agents/index.js';

const REQUIRED_METHODS = [
    'checkInstalled', 'initialize', 'shutdown',
    'createTask', 'reconnectTask', 'sendInput', 'resizeTask',
    'interruptTask', 'stopTask', 'destroyTask',
    'getTaskState', 'getTask', 'getTaskHistory', 'setTaskActive',
] as const;

describe('createBackend()', () => {
    it('resolves claude-code to ClaudeCodeBackend', () => {
        const b = createBackend('claude-code');
        expect(b).toBeInstanceOf(ClaudeCodeBackend);
        expect(b.name).toBe('claude-code');
    });

    it('resolves opencode to OpenCodeBackend', () => {
        const b = createBackend('opencode');
        expect(b).toBeInstanceOf(OpenCodeBackend);
        expect(b.name).toBe('opencode');
    });

    it('falls back to Claude Code for an unrecognised backend type', () => {
        const b = createBackend('not-a-backend' as BackendType);
        expect(b).toBeInstanceOf(ClaudeCodeBackend);
    });

    it('forwards the history directory to the instance', () => {
        const b = createBackend('opencode', undefined, '/tmp/does-not-need-to-exist');
        expect((b as unknown as { historyDir: string }).historyDir).toBe('/tmp/does-not-need-to-exist');
    });

    it('BACKEND_INFO is derived from the agent registry, not hand-written', () => {
        // One of the six copies of the agent list that used to drift
        // independently. It now IS the registry's display info.
        expect(Object.keys(BACKEND_INFO)).toEqual(listAgentIds());
        expect(Object.keys(BACKEND_INFO)).toEqual([...AGENT_IDS]);
        for (const [id, info] of Object.entries(BACKEND_INFO)) {
            expect(info.id).toBe(id);
            expect(info.name.length).toBeGreaterThan(0);
            expect(info.description.length).toBeGreaterThan(0);
            expect(info.installUrl).toMatch(/^https:\/\//);
            // The task-row badge label rides along with the Settings name.
            expect(info.shortLabel).toBe(info.shortLabel.toLowerCase());
        }
    });

    it('every registered BackendType builds something that satisfies the contract', () => {
        for (const type of Object.keys(BACKEND_INFO) as BackendType[]) {
            const b: CodeBackend = createBackend(type);
            expect(b.name).toBe(type);
            for (const m of REQUIRED_METHODS) {
                expect(typeof (b as unknown as Record<string, unknown>)[m]).toBe('function');
            }
            // Accessors must be total even before initialize().
            expect(b.getTask('nope')).toBeUndefined();
            expect(b.getTaskState('nope')).toBeNull();
            expect(b.getTaskHistory('nope')).toBeNull();
        }
    });
});
