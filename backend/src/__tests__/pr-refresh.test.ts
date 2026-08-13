import { describe, it, expect } from 'vitest';
import { selectWorkspacesToRefresh } from '../pr-refresh.js';

const open_running = { number: 1, title: 't', state: 'open' as const, url: 'u', ci: 'running' as const };
const open_passed = { number: 2, title: 't', state: 'open' as const, url: 'u', ci: 'passed' as const };
const merged_passed = { number: 3, title: 't', state: 'merged' as const, url: 'u', ci: 'passed' as const };
const closed_failed = { number: 4, title: 't', state: 'closed' as const, url: 'u', ci: 'failed' as const };

describe('selectWorkspacesToRefresh', () => {
    it('refreshes an IDLE task whose PR still has CI running (the staleness bug)', () => {
        const sel = selectWorkspacesToRefresh(
            [{ workspaceId: '/w', state: 'idle' }],
            [{ id: '/w', prInfo: open_running }],
            new Set(['/w'])          // already seen → old code skipped it forever
        );
        expect(sel).toContain('/w');
    });

    it('refreshes an IDLE task whose PR is open even when CI passed (it can still merge)', () => {
        const sel = selectWorkspacesToRefresh(
            [{ workspaceId: '/w', state: 'idle' }],
            [{ id: '/w', prInfo: open_passed }],
            new Set(['/w'])
        );
        expect(sel).toContain('/w');
    });

    it('skips terminal PRs (merged/closed with settled CI) to avoid pointless gh calls', () => {
        const sel = selectWorkspacesToRefresh(
            [{ workspaceId: '/a', state: 'idle' }, { workspaceId: '/b', state: 'idle' }],
            [{ id: '/a', prInfo: merged_passed }, { id: '/b', prInfo: closed_failed }],
            new Set(['/a', '/b'])
        );
        expect(sel).toEqual([]);
    });

    it('still refreshes active tasks (busy/starting/waiting_input)', () => {
        const sel = selectWorkspacesToRefresh(
            [{ workspaceId: '/w', state: 'busy' }],
            [{ id: '/w', prInfo: merged_passed }],   // terminal PR, but task is active
            new Set(['/w'])
        );
        expect(sel).toContain('/w');
    });

    it('still does the lazy first fetch for a never-seen workspace', () => {
        const sel = selectWorkspacesToRefresh(
            [{ workspaceId: '/w', state: 'idle' }],
            [{ id: '/w', prInfo: null }],
            new Set()                                 // not seen yet
        );
        expect(sel).toContain('/w');
    });

    it('does not re-poll a seen workspace that has no PR at all', () => {
        const sel = selectWorkspacesToRefresh(
            [{ workspaceId: '/w', state: 'idle' }],
            [{ id: '/w', prInfo: null }],
            new Set(['/w'])
        );
        expect(sel).toEqual([]);
    });

    it('deduplicates a workspace that qualifies via several rules', () => {
        const sel = selectWorkspacesToRefresh(
            [{ workspaceId: '/w', state: 'busy' }, { workspaceId: '/w', state: 'idle' }],
            [{ id: '/w', prInfo: open_running }],
            new Set()
        );
        expect(sel).toEqual(['/w']);
    });
});
