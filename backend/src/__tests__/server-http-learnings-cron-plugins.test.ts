/**
 * Integration tests for the Learnings, Cron, Plugin and image-upload/cache
 * HTTP surfaces, driven against the REAL server (createApp) on an ephemeral
 * port via the shared harness.
 *
 * Two external dependencies are neutralised so the suite is hermetic:
 *
 *  1. LearningsStore.generateEmbedding() POSTs to
 *     http://localhost:4001/v1/embeddings (PORTS.BACKEND, hardcoded). That is
 *     the developer's real dev server, which this suite must never touch. We
 *     spy on globalThis.fetch and answer only that URL with a deterministic
 *     bag-of-words vector; every other request (including the harness's own)
 *     passes through to the real implementation.
 *  2. Every cron expression used here is `0 0 <day> 1 *` (midnight, Jan 1st /
 *     2nd), so the scheduler — which createApp starts on a 1s tick — can never
 *     fire a prompt at a task during the run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { startHarness, makeTaskRecord, waitFor, type Harness } from './helpers/server-harness.js';

// ---------------------------------------------------------------------------
// Deterministic embedding stub
// ---------------------------------------------------------------------------

const EMBEDDING_DIM = 128;

/**
 * Bag-of-words embedding: each distinct word gets its own dimension, assigned
 * on first sight. Collision-free (unlike hashing into buckets, which produced
 * spurious similarity between unrelated words), so two texts sharing no words
 * are exactly orthogonal (cosine 0) and identical texts score 1.0.
 */
const wordSlots = new Map<string, number>();
function fakeEmbedding(text: string): number[] {
    const vec = new Array<number>(EMBEDDING_DIM).fill(0);
    for (const word of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let slot = wordSlots.get(word);
        if (slot === undefined) {
            slot = wordSlots.size;
            if (slot >= EMBEDDING_DIM) throw new Error('fakeEmbedding: vocabulary exhausted');
            wordSlots.set(word, slot);
        }
        vec[slot] += 1;
    }
    return vec;
}

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

const WS_LEARN = '/tmp-ws/learnings';
const WS_CRON = '/tmp-ws/cron';
const TASK_CRON = 'task-cron-1';
const TASK_LEARN = 'task-learn-1';
const TASK_PROMPT = 'zebra quokka narwhal';

let h: Harness;
let fetchSpy: { mockRestore(): void } | undefined;
let embeddingCalls = 0;

/**
 * CronScheduler persists to backend/scheduled-tasks.json (a module-level
 * constant, not the harness base dir), so this suite has to clean up after
 * itself if the file did not already exist.
 */
const CRON_FILE = fileURLToPath(new URL('../../scheduled-tasks.json', import.meta.url));
let cronFilePreexisted = false;

beforeAll(async () => {
    cronFilePreexisted = existsSync(CRON_FILE);

    const realFetch = globalThis.fetch.bind(globalThis);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
        if (typeof url === 'string' && url.includes('/v1/embeddings')) {
            embeddingCalls++;
            const parsed = JSON.parse(String(init?.body ?? '{}'));
            return new Response(
                JSON.stringify({ data: [{ embedding: fakeEmbedding(parsed.input ?? '') }] }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            );
        }
        return realFetch(input, init);
    }) as typeof fetch);

    h = await startHarness({
        prefix: '.claudia-lcp-test-',
        workspaces: [{ id: WS_LEARN, name: 'learn-ws' }, { id: WS_CRON, name: 'cron-ws' }],
        tasks: [
            makeTaskRecord(TASK_CRON, WS_CRON),
            makeTaskRecord(TASK_LEARN, WS_LEARN, { prompt: TASK_PROMPT }),
        ],
    });
}, 30000);

afterAll(async () => {
    await h?.stop();
    fetchSpy?.mockRestore();
    if (!cronFilePreexisted) {
        // Saves are debounced 1s and shutdownForTests never calls
        // cronScheduler.stop(), so a flush can still be in flight. Wait for it
        // to land (with every schedule of ours already removed) before
        // unlinking, otherwise the pending timer just recreates the file.
        try {
            await waitFor(
                () => (existsSync(CRON_FILE) ? readFileSync(CRON_FILE, 'utf8') : null),
                (raw) => {
                    if (raw === null) return false;
                    try { return JSON.parse(raw).data?.length === 0; } catch { return false; }
                },
                5000,
                100,
            );
        } catch { /* nothing was ever persisted — nothing to wait for */ }
        try { unlinkSync(CRON_FILE); } catch { /* never created / already gone */ }
    }
}, 15000);

// ===========================================================================
// Learnings
// ===========================================================================

describe('learnings API', () => {
    it('drives the full CRUD + search lifecycle over HTTP', async () => {
        const ws = '/tmp-ws/lifecycle';
        const before = embeddingCalls;

        // --- CREATE ---
        const created = await h.send('POST', '/api/learnings', {
            workspaceId: ws,
            title: 'Pinned title',
            content: 'flibbertigibbet is the original marker word',
            sourceTaskId: TASK_LEARN,
        });
        expect(created.status).toBe(200);
        expect(created.body.id).toMatch(/^learning-\d+-[a-z0-9]+$/);
        expect(created.body.workspaceId).toBe(ws);
        expect(created.body.title).toBe('Pinned title');
        expect(created.body.content).toBe('flibbertigibbet is the original marker word');
        expect(created.body.sourceTaskId).toBe(TASK_LEARN);
        expect(created.body.utility).toBe(0.5);
        expect(created.body.useCount).toBe(0);
        expect(created.body.successCount).toBe(0);
        expect(typeof created.body.createdAt).toBe('string');
        expect(typeof created.body.updatedAt).toBe('string');
        // Embedding vectors are stripped from the wire, only the size is exposed.
        expect(created.body.embeddingDimensions).toBe(EMBEDDING_DIM);
        expect('embedding' in created.body).toBe(false);
        expect(embeddingCalls).toBe(before + 1);

        const id: string = created.body.id;

        // --- READ one ---
        const one = await h.req(`/api/learnings/${id}`);
        expect(one.status).toBe(200);
        expect(one.body.id).toBe(id);
        expect(one.body.title).toBe('Pinned title');
        expect(one.body.embeddingDimensions).toBe(EMBEDDING_DIM);
        expect('embedding' in one.body).toBe(false);

        // --- READ list (unfiltered + workspace-filtered) ---
        const all = await h.req('/api/learnings');
        expect(all.status).toBe(200);
        expect(Array.isArray(all.body.learnings)).toBe(true);
        expect(all.body.learnings.map((l: any) => l.id)).toContain(id);

        const mine = await h.req(`/api/learnings?workspaceId=${encodeURIComponent(ws)}`);
        expect(mine.status).toBe(200);
        expect(mine.body.learnings).toHaveLength(1);
        expect(mine.body.learnings[0].id).toBe(id);

        const other = await h.req('/api/learnings?workspaceId=/tmp-ws/nobody');
        expect(other.status).toBe(200);
        expect(other.body.learnings).toEqual([]);

        // --- UPDATE (and prove it persisted, and that the embedding was regenerated) ---
        const updated = await h.send('PUT', `/api/learnings/${id}`, {
            content: 'grimalkin is the replacement marker word',
        });
        expect(updated.status).toBe(200);
        expect(updated.body.content).toBe('grimalkin is the replacement marker word');
        expect(updated.body.title).toBe('Pinned title'); // untouched field survives

        const afterUpdate = await h.req(`/api/learnings/${id}`);
        expect(afterUpdate.status).toBe(200);
        expect(afterUpdate.body.content).toBe('grimalkin is the replacement marker word');
        expect(Date.parse(afterUpdate.body.updatedAt)).toBeGreaterThanOrEqual(
            Date.parse(afterUpdate.body.createdAt),
        );

        // --- SEARCH: finds it by a term in the (updated) content ---
        const hit = await h.send('POST', '/api/learnings/search', {
            query: 'grimalkin replacement marker',
            workspaceId: ws,
            minScore: 0.01,
        });
        expect(hit.status).toBe(200);
        expect(hit.body.results).toHaveLength(1);
        expect(hit.body.results[0].learning.id).toBe(id);
        expect(hit.body.results[0].score).toBeGreaterThan(0);
        expect('embedding' in hit.body.results[0].learning).toBe(false);
        expect(hit.body.results[0].learning.embeddingDimensions).toBe(EMBEDDING_DIM);

        // The pre-update marker word no longer matches — the embedding really
        // was recomputed on PUT rather than left stale.
        const stale = await h.send('POST', '/api/learnings/search', {
            query: 'flibbertigibbet',
            workspaceId: ws,
            minScore: 0.01,
        });
        expect(stale.status).toBe(200);
        expect(stale.body.results).toEqual([]);

        // --- DELETE, then the read is a 404 ---
        const del = await h.send('DELETE', `/api/learnings/${id}`);
        expect(del.status).toBe(200);
        expect(del.body).toEqual({ success: true });

        const gone = await h.req(`/api/learnings/${id}`);
        expect(gone.status).toBe(404);
        expect(gone.body).toEqual({ error: 'Learning not found' });

        const listAfter = await h.req(`/api/learnings?workspaceId=${encodeURIComponent(ws)}`);
        expect(listAfter.body.learnings).toEqual([]);
    }, 20000);

    it('rejects a create that is missing a required field with 400, not 500', async () => {
        for (const body of [
            { title: 't', content: 'c' },                 // no workspaceId
            { workspaceId: WS_LEARN, content: 'c' },      // no title
            { workspaceId: WS_LEARN, title: 't' },        // no content
            {},
        ]) {
            const res = await h.send('POST', '/api/learnings', body);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ error: 'Missing required fields: workspaceId, title, content' });
        }
    });

    it('rejects a search with no query with 400, not 500', async () => {
        const res = await h.send('POST', '/api/learnings/search', { workspaceId: WS_LEARN });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Missing query' });
    });

    it('404s on unknown learning ids for GET / PUT / DELETE', async () => {
        const get = await h.req('/api/learnings/learning-does-not-exist');
        expect(get.status).toBe(404);
        expect(get.body).toEqual({ error: 'Learning not found' });

        const put = await h.send('PUT', '/api/learnings/learning-does-not-exist', { title: 'x' });
        expect(put.status).toBe(404);
        expect(put.body).toEqual({ error: 'Learning not found' });

        const del = await h.send('DELETE', '/api/learnings/learning-does-not-exist');
        expect(del.status).toBe(404);
        expect(del.body).toEqual({ error: 'Learning not found' });
    });

    it('GET /api/tasks/:taskId/learnings returns matches, context text and injection state', async () => {
        // A learning whose text is the task's prompt scores ~1.0, comfortably
        // over the route's hardcoded minScore of 0.3.
        const created = await h.send('POST', '/api/learnings', {
            workspaceId: WS_LEARN,
            title: TASK_PROMPT,
            content: TASK_PROMPT,
        });
        expect(created.status).toBe(200);
        const id: string = created.body.id;

        try {
            const res = await h.req(`/api/tasks/${TASK_LEARN}/learnings`);
            expect(res.status).toBe(200);
            expect(res.body.results).toHaveLength(1);
            expect(res.body.results[0].learning.id).toBe(id);
            expect(res.body.results[0].score).toBeGreaterThan(0.3);
            expect('embedding' in res.body.results[0].learning).toBe(false);
            expect(res.body.contextText).toContain('[RELEVANT LEARNINGS]');
            expect(res.body.contextText).toContain(TASK_PROMPT);
            // Nothing has actually been injected into this (never-spawned) task.
            expect(res.body.injected).toEqual([]);
            expect(res.body.injectedCount).toBe(0);
        } finally {
            await h.send('DELETE', `/api/learnings/${id}`);
        }
    }, 20000);

    it('GET /api/tasks/:taskId/learnings 404s for an unknown task', async () => {
        const res = await h.req('/api/tasks/task-nope/learnings');
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Task not found' });
    });
});

// ===========================================================================
// Cron
// ===========================================================================

describe('cron API', () => {
    it('creates, lists, updates and deletes a schedule for a seeded task', async () => {
        // Jan 1st 00:00 — cannot fire during the test run.
        const created = await h.send('POST', `/api/tasks/${TASK_CRON}/cron`, {
            cronExpression: '0 0 1 1 *',
            prompt: 'new year ping',
            isRecurring: true,
        });
        expect(created.status).toBe(200);
        const cronId: string = created.body.id;
        expect(typeof cronId).toBe('string');
        expect(cronId.length).toBeGreaterThan(0);
        expect(created.body.taskId).toBe(TASK_CRON);
        expect(created.body.workspaceId).toBe(WS_CRON);
        expect(created.body.cronExpression).toBe('0 0 1 1 *');
        expect(created.body.prompt).toBe('new year ping');
        expect(created.body.isRecurring).toBe(true);
        expect(created.body.isPaused).toBe(false);
        expect(created.body.fireCount).toBe(0);
        expect(typeof created.body.createdAt).toBe('string');
        expect(typeof created.body.expiresAt).toBe('string');
        // Next fire is a real future timestamp on Jan 1st.
        const nextFire = new Date(created.body.nextFireAt);
        expect(nextFire.getTime()).toBeGreaterThan(Date.now());
        expect(nextFire.getMonth()).toBe(0);
        expect(nextFire.getDate()).toBe(1);
        // describeCronExpression has no pattern for day-of-month schedules and
        // echoes the raw expression back.
        expect(created.body.description).toBe('0 0 1 1 *');

        try {
            // --- both list views show it ---
            const all = await h.req('/api/cron');
            expect(all.status).toBe(200);
            expect(Array.isArray(all.body)).toBe(true);
            const inAll = all.body.find((c: any) => c.id === cronId);
            expect(inAll).toBeTruthy();
            expect(inAll.prompt).toBe('new year ping');
            expect(inAll.description).toBe('0 0 1 1 *');

            const forTask = await h.req(`/api/tasks/${TASK_CRON}/cron`);
            expect(forTask.status).toBe(200);
            expect(forTask.body.map((c: any) => c.id)).toContain(cronId);
            expect(forTask.body.every((c: any) => c.taskId === TASK_CRON)).toBe(true);

            // --- update ---
            const updated = await h.send('PUT', `/api/cron/${cronId}`, {
                cronExpression: '0 0 2 1 *',
                prompt: 'second of january ping',
                isPaused: true,
            });
            expect(updated.status).toBe(200);
            expect(updated.body.id).toBe(cronId);
            expect(updated.body.cronExpression).toBe('0 0 2 1 *');
            expect(updated.body.prompt).toBe('second of january ping');
            expect(updated.body.isPaused).toBe(true);
            expect(updated.body.description).toBe('0 0 2 1 *');
            expect(new Date(updated.body.nextFireAt).getDate()).toBe(2);

            // ...and it persisted
            const afterUpdate = await h.req('/api/cron');
            const persisted = afterUpdate.body.find((c: any) => c.id === cronId);
            expect(persisted.prompt).toBe('second of january ping');
            expect(persisted.isPaused).toBe(true);
            expect(persisted.cronExpression).toBe('0 0 2 1 *');
        } finally {
            const del = await h.send('DELETE', `/api/cron/${cronId}`);
            expect(del.status).toBe(200);
            expect(del.body).toEqual({ success: true, cronId });
        }

        // --- gone from the list, and a second delete is a 404 ---
        const after = await h.req('/api/cron');
        expect(after.body.map((c: any) => c.id)).not.toContain(cronId);

        const again = await h.send('DELETE', `/api/cron/${cronId}`);
        expect(again.status).toBe(404);
        expect(again.body).toEqual({ error: 'Scheduled task not found' });
    }, 30000);

    it('rejects an invalid cron expression with 400, not 500', async () => {
        for (const expr of ['not a cron', '* * *', '1 2 3 4 5 6', 'x * * * *', '* * * * */0', '']) {
            const res = await h.send('POST', `/api/tasks/${TASK_CRON}/cron`, {
                cronExpression: expr,
                prompt: 'should never be scheduled',
            });
            expect(res.status, `expr=${JSON.stringify(expr)}`).toBe(400);
            expect(typeof res.body.error).toBe('string');
        }
        // The empty expression trips the required-fields guard; the rest reach
        // the parser and come back with its message.
        const bad = await h.send('POST', `/api/tasks/${TASK_CRON}/cron`, {
            cronExpression: 'not a cron',
            prompt: 'p',
        });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toContain('Invalid cron expression');

        // Nothing was actually scheduled.
        const list = await h.req(`/api/tasks/${TASK_CRON}/cron`);
        expect(list.body).toEqual([]);
    }, 20000);

    it('accepts an out-of-range field that can never fire', async () => {
        // BUG: parseCronField never range-checks values against the (min, max)
        // it is handed, so "99 * * * *" (minute 99) is accepted with a 200. The
        // schedule is stored with nextFireAt undefined — getNextFireTime
        // searches 366 days, matches nothing, and returns null — so it silently
        // never fires. It should be a 400 like any other invalid expression.
        // Pinning current behaviour.
        const res = await h.send('POST', `/api/tasks/${TASK_CRON}/cron`, {
            cronExpression: '99 * * * *',
            prompt: 'never fires',
        });
        expect(res.status).toBe(200);
        expect(res.body.cronExpression).toBe('99 * * * *');
        expect(res.body.nextFireAt).toBeUndefined();
        await h.send('DELETE', `/api/cron/${res.body.id}`);
    }, 30000);

    it('rejects a create with missing fields with 400, not 500', async () => {
        for (const body of [{}, { prompt: 'p' }, { cronExpression: '0 0 1 1 *' }]) {
            const res = await h.send('POST', `/api/tasks/${TASK_CRON}/cron`, body);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ error: 'cronExpression and prompt are required' });
        }
    });

    it('404s creating a schedule for an unknown task', async () => {
        const res = await h.send('POST', '/api/tasks/task-nope/cron', {
            cronExpression: '0 0 1 1 *',
            prompt: 'p',
        });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Task not found' });
    });

    it('404s updating an unknown cron id, even with an invalid expression', async () => {
        const res = await h.send('PUT', '/api/cron/cron-does-not-exist', { prompt: 'x' });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Scheduled task not found' });

        // The unknown-id check runs before expression validation.
        const bad = await h.send('PUT', '/api/cron/cron-does-not-exist', { cronExpression: 'nope' });
        expect(bad.status).toBe(404);
        expect(bad.body).toEqual({ error: 'Scheduled task not found' });
    });

    it('rejects an invalid expression on an existing schedule with 400, not 500', async () => {
        const created = await h.send('POST', `/api/tasks/${TASK_CRON}/cron`, {
            cronExpression: '0 0 1 1 *',
            prompt: 'temp',
        });
        expect(created.status).toBe(200);
        const cronId: string = created.body.id;
        try {
            const res = await h.send('PUT', `/api/cron/${cronId}`, { cronExpression: 'every otherday' });
            expect(res.status).toBe(400);
            expect(res.body.error).toContain('Invalid cron expression');

            // The original expression survived the rejected update.
            const still = await h.req('/api/cron');
            expect(still.body.find((c: any) => c.id === cronId).cronExpression).toBe('0 0 1 1 *');
        } finally {
            await h.send('DELETE', `/api/cron/${cronId}`);
        }
    }, 20000);

    it('returns an empty list (not a 404) for an unknown task id', async () => {
        const res = await h.req('/api/tasks/task-nope/cron');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

// ===========================================================================
// Plugins
// ===========================================================================

describe('plugins API', () => {
    it('lists the on-disk plugin registry with manifest metadata', async () => {
        const res = await h.req('/api/plugins');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.plugins)).toBe(true);
        expect(res.body.plugins.length).toBeGreaterThan(0);

        for (const p of res.body.plugins) {
            expect(typeof p.name).toBe('string');
            expect(typeof p.version).toBe('string');
            expect(['ai-provider', 'utility', 'integration']).toContain(p.type);
            expect(typeof p.displayName).toBe('string');
            expect(typeof p.hasSettingsUI).toBe('boolean');
            expect(typeof p.enabled).toBe('boolean');
        }

        const example = res.body.plugins.find((p: any) => p.name === 'example-plugin');
        expect(example).toMatchObject({
            name: 'example-plugin',
            version: '1.0.0',
            type: 'utility',
            displayName: 'Example Plugin',
            author: 'Claudia Team',
            enabled: false, // config store starts empty in the sandboxed base dir
        });
    });

    it('round-trips enable then disable on a real plugin', async () => {
        const enable = await h.send('POST', '/api/plugins/example-plugin/enable');
        expect(enable.status).toBe(200);
        expect(enable.body.success).toBe(true);
        expect(enable.body.message).toContain('enabled');

        const enabled = await h.req('/api/plugins');
        expect(enabled.body.plugins.find((p: any) => p.name === 'example-plugin').enabled).toBe(true);
        // Other plugins are untouched by the flip.
        expect(enabled.body.plugins.filter((p: any) => p.enabled).map((p: any) => p.name))
            .toEqual(['example-plugin']);

        const disable = await h.send('POST', '/api/plugins/example-plugin/disable');
        expect(disable.status).toBe(200);
        expect(disable.body.success).toBe(true);
        expect(disable.body.requiresRestart).toBe(true);

        const disabled = await h.req('/api/plugins');
        expect(disabled.body.plugins.find((p: any) => p.name === 'example-plugin').enabled).toBe(false);
    }, 20000);

    it('does not 500 on an unknown plugin name', async () => {
        // BUG: enable/disable never check that the plugin exists. An unknown
        // name is happily written into config.enabledPlugins and answered with
        // 200 { success: true } instead of 404 { error: 'Plugin not found' }.
        // Pinning the current behaviour so the fix is a deliberate change.
        const enable = await h.send('POST', '/api/plugins/no-such-plugin/enable');
        expect(enable.status).not.toBe(500);
        expect(enable.status).toBe(200); // should be 404
        expect(enable.body).toEqual({
            success: true,
            message: 'Plugin no-such-plugin enabled successfully',
        });

        // The phantom name is not reflected in the registry listing (that is
        // driven by on-disk manifests), so the only trace is the config entry.
        const list = await h.req('/api/plugins');
        expect(list.body.plugins.map((p: any) => p.name)).not.toContain('no-such-plugin');

        const disable = await h.send('POST', '/api/plugins/no-such-plugin/disable');
        expect(disable.status).not.toBe(500);
        expect(disable.status).toBe(200); // should be 404
        expect(disable.body.success).toBe(true);
        expect(disable.body.requiresRestart).toBe(true);
    }, 20000);
});

// ===========================================================================
// Image upload / cache
// ===========================================================================

describe('image upload + cache API', () => {
    const imagesDir = () => join(h.base, '.claudia', 'cache', 'images');

    const uploadForm = (bytes: Buffer, type: string, name: string) => {
        const fd = new FormData();
        fd.append('image', new Blob([new Uint8Array(bytes)], { type }), name);
        return fd;
    };

    it('uploads, serves, then deletes an image', async () => {
        const res = await h.req('/api/upload/image', {
            method: 'POST',
            body: uploadForm(TINY_PNG, 'image/png', 'tiny.png'),
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.filename).toMatch(/^image-\d+-\d+\.png$/);
        expect(res.body.originalName).toBe('tiny.png');
        expect(res.body.mimetype).toBe('image/png');
        expect(res.body.size).toBe(TINY_PNG.length);

        const filename: string = res.body.filename;
        // $HOME is redirected at the harness base, so the file must land inside
        // the sandbox, never in the developer's real ~/.claudia.
        expect(res.body.filePath).toBe(join(imagesDir(), filename));
        expect(existsSync(res.body.filePath)).toBe(true);
        expect(readFileSync(res.body.filePath)).toEqual(TINY_PNG);

        // --- served back byte-for-byte ---
        const served = await h.fetch(`/api/cache/images/${filename}`);
        expect(served.status).toBe(200);
        expect(served.headers.get('content-type')).toContain('image/png');
        expect(Buffer.from(await served.arrayBuffer())).toEqual(TINY_PNG);

        // --- deleted ---
        const del = await h.send('DELETE', `/api/upload/image/${filename}`);
        expect(del.status).toBe(200);
        expect(del.body).toEqual({ success: true });
        expect(existsSync(join(imagesDir(), filename))).toBe(false);

        const gone = await h.req(`/api/cache/images/${filename}`);
        expect(gone.status).toBe(404);
        expect(gone.body).toEqual({ error: 'Image not found' });

        const delAgain = await h.send('DELETE', `/api/upload/image/${filename}`);
        expect(delAgain.status).toBe(404);
        expect(delAgain.body).toEqual({ error: 'Image not found' });
    }, 20000);

    it('rejects an upload with no file at all with 400', async () => {
        const json = await h.send('POST', '/api/upload/image', { nope: true });
        expect(json.status).toBe(400);
        expect(json.body).toEqual({ error: 'No image file provided' });

        // Well-formed multipart, but the file is under the wrong field name.
        // BUG: same missing-error-middleware problem as the mimetype case —
        // multer's LIMIT_UNEXPECTED_FILE is a client error but surfaces as 500.
        const fd = new FormData();
        fd.append('notTheImageField', new Blob([new Uint8Array(TINY_PNG)], { type: 'image/png' }), 'x.png');
        const wrongField = await h.req('/api/upload/image', { method: 'POST', body: fd });
        expect(wrongField.status).toBe(500); // should be 400
        expect(existsSync(join(imagesDir(), 'x.png'))).toBe(false);
    });

    it('rejects a non-image mimetype', async () => {
        const res = await h.fetch('/api/upload/image', {
            method: 'POST',
            body: uploadForm(Buffer.from('not an image'), 'text/plain', 'notes.txt'),
        });
        // BUG: multer's fileFilter rejects by calling cb(new Error(...)), and
        // the app installs no error-handling middleware, so the rejection
        // surfaces as Express's default 500 HTML page rather than a 4xx JSON
        // body. It IS rejected (nothing is written to disk), but the status is
        // wrong. Pinning current behaviour.
        expect(res.status).toBe(500);
        expect(res.status).not.toBe(200);
        // Nothing landed in the cache dir.
        const stray = existsSync(imagesDir()) ? readdirSync(imagesDir()) : [];
        expect(stray.filter(f => f.endsWith('.txt'))).toEqual([]);
    }, 20000);

    it('rejects traversal filenames with 400 on both DELETE and GET', async () => {
        // Express decodes :filename before the handler runs, so percent-encoded
        // separators must be caught by the same guard as literal ones.
        const attempts = [
            '..%2Fescape.png',            // encoded forward slash
            '%2e%2e%2fescape.png',        // fully encoded ../
            '..%5Cescape.png',            // encoded backslash (Windows)
            'sub%2Fdir.png',              // plain nested path
            'a%2e%2eb.png',               // encoded dots mid-segment
            encodeURIComponent('../../../etc/passwd'),
        ];
        // NB: a bare "%2e%2e" segment is not in this list — the WHATWG URL
        // parser in fetch resolves it as a dot-segment before the request is
        // sent, so it never reaches the route at all (it 404s on /api/upload/).

        for (const attempt of attempts) {
            const del = await h.send('DELETE', `/api/upload/image/${attempt}`);
            expect(del.status, `DELETE ${attempt}`).toBe(400);
            expect(del.body).toEqual({ error: 'Invalid filename' });

            const get = await h.req(`/api/cache/images/${attempt}`);
            expect(get.status, `GET ${attempt}`).toBe(400);
            expect(get.body).toEqual({ error: 'Invalid filename' });
        }
    });

    it('cannot read a file outside the cache dir via an encoded traversal', async () => {
        // uploadsDir is <base>/.claudia/cache/images, so ../../../ escapes to <base>.
        const secretPath = join(h.base, 'traversal-secret.txt');
        writeFileSync(secretPath, 'TOP-SECRET');
        try {
            const res = await h.fetch(
                `/api/cache/images/${encodeURIComponent('../../../traversal-secret.txt')}`,
            );
            expect(res.status).toBe(400);
            expect(await res.text()).not.toContain('TOP-SECRET');
        } finally {
            unlinkSync(secretPath);
        }
    });
});
