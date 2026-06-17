import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { LearningsStore } from '../learnings-store.js';

/**
 * Embedding stub. We map known text -> a fixed embedding so cosine similarity is
 * deterministic. Anything else falls back to a neutral vector.
 *
 * Vectors are chosen so that:
 *  - "alpha" texts are identical to each other (similarity 1.0)
 *  - "beta" texts are orthogonal to alpha (similarity 0.0)
 *  - the query "find-alpha" matches alpha exactly
 */
const EMBEDDINGS: Record<string, number[]> = {
    alpha: [1, 0, 0],
    beta: [0, 1, 0],
    gamma: [0, 0, 1],
};

function embeddingFor(text: string): number[] {
    for (const key of Object.keys(EMBEDDINGS)) {
        if (text.includes(key)) return EMBEDDINGS[key];
    }
    return [0.5, 0.5, 0.5];
}

describe('LearningsStore', () => {
    let testBaseDir: string;
    let store: LearningsStore;
    let fetchSpy: any;

    beforeEach(() => {
        const uniqueId = Date.now() + '-' + Math.random().toString(36).substring(7);
        testBaseDir = join(homedir(), '.claudia-learnings-test-' + uniqueId);
        mkdirSync(testBaseDir, { recursive: true });

        // Mock the embeddings endpoint. The store POSTs { input } and expects
        // { data: [{ embedding }] } back.
        fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init?: any) => {
            const parsed = JSON.parse(init.body);
            const embedding = embeddingFor(parsed.input);
            return new Response(JSON.stringify({ data: [{ embedding }] }), { status: 200 });
        });

        store = new LearningsStore(testBaseDir);
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        try {
            rmSync(testBaseDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
            // ignore
        }
    });

    describe('initialization', () => {
        it('starts empty when no file exists', () => {
            expect(store.getLearnings()).toEqual([]);
        });

        it('does not create the file until something is saved', () => {
            const file = join(testBaseDir, 'learnings.json');
            expect(existsSync(file)).toBe(false);
        });
    });

    describe('addLearning', () => {
        it('adds a learning with generated embedding and defaults', async () => {
            const learning = await store.addLearning({
                workspaceId: 'ws-1',
                title: 'alpha title',
                content: 'some alpha content',
                sourceTaskId: 'task-9',
            });

            expect(learning.id).toMatch(/^learning-/);
            expect(learning.workspaceId).toBe('ws-1');
            expect(learning.title).toBe('alpha title');
            expect(learning.content).toBe('some alpha content');
            expect(learning.embedding).toEqual([1, 0, 0]);
            expect(learning.sourceTaskId).toBe('task-9');
            expect(learning.utility).toBe(0.5);
            expect(learning.useCount).toBe(0);
            expect(learning.successCount).toBe(0);
            expect(learning.createdAt).toBeTruthy();
            expect(learning.updatedAt).toBe(learning.createdAt);
        });

        it('persists the learning to disk', async () => {
            await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'x' });
            const file = join(testBaseDir, 'learnings.json');
            expect(existsSync(file)).toBe(true);

            const reloaded = new LearningsStore(testBaseDir);
            expect(reloaded.getLearnings()).toHaveLength(1);
            expect(reloaded.getLearnings()[0].title).toBe('alpha');
        });

        it('writes a versioned envelope to disk', async () => {
            await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'x' });
            const raw = JSON.parse(readFileSync(join(testBaseDir, 'learnings.json'), 'utf-8'));
            expect(raw.schemaVersion).toBe(1);
            expect(raw.data.learnings).toHaveLength(1);
        });
    });

    describe('getLearnings / getLearning', () => {
        it('filters by workspace', async () => {
            await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'a' });
            await store.addLearning({ workspaceId: 'ws-2', title: 'beta', content: 'b' });

            expect(store.getLearnings('ws-1')).toHaveLength(1);
            expect(store.getLearnings('ws-1')[0].workspaceId).toBe('ws-1');
            expect(store.getLearnings('ws-2')).toHaveLength(1);
            expect(store.getLearnings()).toHaveLength(2);
        });

        it('getLearnings() returns a copy, not the internal array', async () => {
            await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'a' });
            const list = store.getLearnings();
            list.pop();
            expect(store.getLearnings()).toHaveLength(1);
        });

        it('getLearning returns the matching entry or undefined', async () => {
            const l = await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'a' });
            expect(store.getLearning(l.id)?.id).toBe(l.id);
            expect(store.getLearning('nope')).toBeUndefined();
        });
    });

    describe('deleteLearning', () => {
        it('removes and persists the deletion', async () => {
            const l = await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'a' });
            expect(store.deleteLearning(l.id)).toBe(true);
            expect(store.getLearnings()).toHaveLength(0);

            const reloaded = new LearningsStore(testBaseDir);
            expect(reloaded.getLearnings()).toHaveLength(0);
        });

        it('returns false for an unknown id', () => {
            expect(store.deleteLearning('missing')).toBe(false);
        });
    });

    describe('updateLearning', () => {
        it('updates title/content and regenerates the embedding', async () => {
            const l = await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'a' });
            expect(l.embedding).toEqual([1, 0, 0]);

            const updated = await store.updateLearning(l.id, { title: 'beta', content: 'b' });
            expect(updated).not.toBeNull();
            expect(updated!.title).toBe('beta');
            expect(updated!.content).toBe('b');
            expect(updated!.embedding).toEqual([0, 1, 0]);
        });

        it('allows partial updates (only content)', async () => {
            const l = await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'a' });
            const updated = await store.updateLearning(l.id, { content: 'beta only' });
            expect(updated!.title).toBe('alpha');
            expect(updated!.content).toBe('beta only');
        });

        it('returns null for an unknown id', async () => {
            expect(await store.updateLearning('missing', { title: 'x' })).toBeNull();
        });
    });

    describe('updateUtility (MemRL)', () => {
        it('increases utility toward 1 on success', async () => {
            const l = await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'a' });
            store.updateUtility(l.id, true, 0.1);
            const after = store.getLearning(l.id)!;
            // 0.5 + 0.1 * (1 - 0.5) = 0.55
            expect(after.utility).toBeCloseTo(0.55, 5);
            expect(after.useCount).toBe(1);
            expect(after.successCount).toBe(1);
        });

        it('decreases utility toward 0 on failure and does not bump successCount', async () => {
            const l = await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'a' });
            store.updateUtility(l.id, false, 0.1);
            const after = store.getLearning(l.id)!;
            // 0.5 + 0.1 * (0 - 0.5) = 0.45
            expect(after.utility).toBeCloseTo(0.45, 5);
            expect(after.useCount).toBe(1);
            expect(after.successCount).toBe(0);
        });

        it('is a no-op for an unknown id', () => {
            expect(() => store.updateUtility('missing', true)).not.toThrow();
        });

        it('persists utility updates', async () => {
            const l = await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'a' });
            store.updateUtility(l.id, true);
            const reloaded = new LearningsStore(testBaseDir);
            expect(reloaded.getLearning(l.id)!.useCount).toBe(1);
        });
    });

    describe('recordRetrieval', () => {
        it('bumps useCount for each existing id and ignores missing ones', async () => {
            const a = await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'a' });
            const b = await store.addLearning({ workspaceId: 'ws-1', title: 'beta', content: 'b' });
            store.recordRetrieval([a.id, b.id, 'missing']);
            expect(store.getLearning(a.id)!.useCount).toBe(1);
            expect(store.getLearning(b.id)!.useCount).toBe(1);
        });
    });

    describe('searchLearnings', () => {
        it('returns matches above minScore ranked by combined score', async () => {
            await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'alpha doc' });
            await store.addLearning({ workspaceId: 'ws-1', title: 'beta', content: 'beta doc' });

            // Query embeds to [1,0,0] (alpha). alpha sim=1, beta sim=0 (below 0.3).
            const results = await store.searchLearnings({ query: 'alpha' });
            expect(results).toHaveLength(1);
            expect(results[0].learning.title).toBe('alpha');
            expect(results[0].score).toBeCloseTo(1, 5);
        });

        it('filters by workspaceId', async () => {
            await store.addLearning({ workspaceId: 'ws-1', title: 'alpha', content: 'alpha a' });
            await store.addLearning({ workspaceId: 'ws-2', title: 'alpha', content: 'alpha b' });

            const results = await store.searchLearnings({ query: 'alpha', workspaceId: 'ws-2' });
            expect(results).toHaveLength(1);
            expect(results[0].learning.workspaceId).toBe('ws-2');
        });

        it('respects topK', async () => {
            await store.addLearning({ workspaceId: 'ws-1', title: 'alpha one', content: 'alpha' });
            await store.addLearning({ workspaceId: 'ws-1', title: 'alpha two', content: 'alpha' });
            await store.addLearning({ workspaceId: 'ws-1', title: 'alpha three', content: 'alpha' });

            const results = await store.searchLearnings({ query: 'alpha', topK: 2 });
            expect(results).toHaveLength(2);
        });

        it('drops results below minScore', async () => {
            await store.addLearning({ workspaceId: 'ws-1', title: 'beta', content: 'beta' });
            // Query embeds to alpha [1,0,0], beta is orthogonal -> sim 0 < 0.3
            const results = await store.searchLearnings({ query: 'alpha' });
            expect(results).toHaveLength(0);
        });

        it('utility ranking reorders equally-similar results', async () => {
            const low = await store.addLearning({ workspaceId: 'ws-1', title: 'alpha low', content: 'alpha' });
            const high = await store.addLearning({ workspaceId: 'ws-1', title: 'alpha high', content: 'alpha' });
            // Both have identical similarity (1.0). Make `high` more useful.
            store.updateUtility(high.id, true);
            store.updateUtility(high.id, true);

            const ranked = await store.searchLearnings({ query: 'alpha', useUtilityRanking: true });
            expect(ranked[0].learning.id).toBe(high.id);

            const bySimOnly = await store.searchLearnings({ query: 'alpha', useUtilityRanking: false });
            // Pure similarity tie -> stable original insertion order (low first).
            expect(bySimOnly.map(r => r.learning.id)).toContain(low.id);
        });
    });

    describe('formatForContext', () => {
        it('returns empty string for no results', () => {
            expect(store.formatForContext([])).toBe('');
        });

        it('formats title, content, relevance and utility', async () => {
            const l = await store.addLearning({ workspaceId: 'ws-1', title: 'My Title', content: 'Body text' });
            const text = store.formatForContext([{ learning: l, score: 0.8 }]);
            expect(text).toContain('[RELEVANT LEARNINGS]');
            expect(text).toContain('## My Title');
            expect(text).toContain('Body text');
            expect(text).toContain('Relevance: 80%');
            expect(text).toContain('Utility: 50%');
            expect(text).toContain('[/RELEVANT LEARNINGS]');
        });
    });

    describe('loadData resilience', () => {
        it('falls back to empty on malformed JSON', () => {
            writeFileSync(join(testBaseDir, 'learnings.json'), 'this is not json {{{');
            const s = new LearningsStore(testBaseDir);
            expect(s.getLearnings()).toEqual([]);
        });

        it('reads a legacy (unversioned) file shape', async () => {
            const legacy = { learnings: [{
                id: 'legacy-1',
                workspaceId: 'ws-1',
                title: 'legacy',
                content: 'old format',
                embedding: [1, 0, 0],
                createdAt: '2020-01-01T00:00:00.000Z',
                updatedAt: '2020-01-01T00:00:00.000Z',
                utility: 0.5,
                useCount: 0,
                successCount: 0,
            }], version: 1 };
            writeFileSync(join(testBaseDir, 'learnings.json'), JSON.stringify(legacy));

            const s = new LearningsStore(testBaseDir);
            expect(s.getLearnings()).toHaveLength(1);
            expect(s.getLearning('legacy-1')?.title).toBe('legacy');
        });
    });

    describe('generateEmbedding', () => {
        it('throws when the embedding API returns an error status', async () => {
            fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }));
            await expect(store.generateEmbedding('alpha')).rejects.toThrow(/Embedding API error: 500/);
        });

        it('throws when the response has no embedding', async () => {
            fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
            await expect(store.generateEmbedding('alpha')).rejects.toThrow(/No embedding in response/);
        });

        it('returns the embedding from a well-formed response', async () => {
            const emb = await store.generateEmbedding('alpha');
            expect(emb).toEqual([1, 0, 0]);
        });
    });
});
