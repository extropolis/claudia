/**
 * HTTP-layer integration tests for /api/verifications, focused on the judge
 * route.
 *
 * These boot the REAL Express app through the shared harness and drive it over
 * a socket, so they cover the parts the store-level unit tests
 * (verification-store.test.ts) structurally cannot: request validation, status
 * codes, the 500-char note truncation, route declaration order (the literal
 * /evidence path vs the /:cardId param), and the `notified` flag the judge
 * route synthesises on top of the store.
 *
 * Cards are seeded through POST /api/verifications with capturer 'manual',
 * which files an image already on disk as evidence. That is the only capturer
 * that does not shell out to Playwright/a real browser, so the suite stays
 * hermetic and fast.
 *
 * Temp dirs live under homedir(), NOT os.tmpdir(): on macOS /tmp resolves under
 * /var, which validateWorkspacePath blocklists as a system path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { startHarness, makeTaskRecord, type Harness } from './helpers/server-harness.js';
import type { VerificationCard } from '@claudia/shared';

/** PNG magic bytes. The store never decodes evidence, so this is enough. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TASK_ID = 'task-verify-1';
/** A second real task, for asserting the feed's taskId filter. */
const OTHER_TASK_ID = 'task-verify-2';
const WORKSPACE_ID = 'ws-verify-1';

describe('HTTP /api/verifications', () => {
    let h: Harness;
    let imagePath: string;

    /** File a card via the real POST route using the 'manual' capturer. */
    async function createCard(
        overrides: Record<string, unknown> = {},
    ): Promise<VerificationCard> {
        const { status, body } = await h.send<VerificationCard>('POST', '/api/verifications', {
            taskId: TASK_ID,
            workspaceId: WORKSPACE_ID,
            claim: 'the coin pickup plays its animation',
            verdict: 'needs-human-eyes',
            capturer: 'manual',
            imagePath,
            ...overrides,
        });
        expect(status, `seeding a card failed: ${JSON.stringify(body)}`).toBe(200);
        return body;
    }

    const judge = (cardId: string, body: unknown) =>
        h.send<VerificationCard & { notified: boolean; error?: string }>(
            'POST',
            `/api/verifications/${cardId}/judge`,
            body,
        );

    beforeEach(async () => {
        h = await startHarness({
            prefix: '.claudia-http-verif-',
            workspaces: [{ id: WORKSPACE_ID, name: 'verify-ws' }],
            tasks: [
                makeTaskRecord(TASK_ID, WORKSPACE_ID),
                makeTaskRecord(OTHER_TASK_ID, WORKSPACE_ID),
            ],
        });
        // Source image for the 'manual' capturer. Lives inside the harness base
        // so it is torn down with everything else.
        imagePath = join(h.base, 'shot.png');
        writeFileSync(imagePath, PNG_BYTES);
    });

    afterEach(async () => {
        await h?.stop();
    });

    describe('POST /api/verifications/:cardId/judge', () => {
        it('records looks-wrong with a reason and note, and persists them', async () => {
            const card = await createCard();

            const { status, body } = await judge(card.id, {
                humanVerdict: 'looks-wrong',
                rejectionReason: 'wrong-layout',
                rejectionNote: 'the sidebar overlaps the canvas',
            });

            expect(status).toBe(200);
            expect(body.humanVerdict).toBe('looks-wrong');
            expect(body.rejectionReason).toBe('wrong-layout');
            expect(body.rejectionNote).toBe('the sidebar overlaps the canvas');
            expect(body.humanVerdictAt).toBeTruthy();

            // Round-trip through GET to prove it was persisted, not just echoed.
            const fetched = await h.req<VerificationCard>(`/api/verifications/${card.id}`);
            expect(fetched.status).toBe(200);
            expect(fetched.body.humanVerdict).toBe('looks-wrong');
            expect(fetched.body.rejectionReason).toBe('wrong-layout');
            expect(fetched.body.rejectionNote).toBe('the sidebar overlaps the canvas');
        });

        it('accepts every valid rejection reason', async () => {
            const reasons = [
                'wrong-layout',
                'visual-glitch',
                'not-what-i-asked',
                'nothing-rendered',
                'other',
            ];
            for (const reason of reasons) {
                const card = await createCard();
                const { status, body } = await judge(card.id, {
                    humanVerdict: 'looks-wrong',
                    rejectionReason: reason,
                });
                expect(status, `reason ${reason} should be accepted`).toBe(200);
                expect(body.rejectionReason).toBe(reason);
            }
        });

        it('400s on an invalid rejectionReason and leaves the card unjudged', async () => {
            const card = await createCard();

            const { status, body } = await judge(card.id, {
                humanVerdict: 'looks-wrong',
                rejectionReason: 'the-vibes-are-off',
            });

            expect(status).toBe(400);
            expect(body.error).toMatch(/rejectionReason must be one of/);
            expect(body.error).toContain('wrong-layout');

            // Validation runs before judgeCard, so nothing should have been written.
            const fetched = await h.req<VerificationCard>(`/api/verifications/${card.id}`);
            expect(fetched.body.humanVerdict).toBeUndefined();
        });

        it('400s on an invalid humanVerdict', async () => {
            const card = await createCard();

            const { status, body } = await judge(card.id, { humanVerdict: 'looks-ok-ish' });

            expect(status).toBe(400);
            expect(body.error).toMatch(/humanVerdict must be/);

            const fetched = await h.req<VerificationCard>(`/api/verifications/${card.id}`);
            expect(fetched.body.humanVerdict).toBeUndefined();
        });

        it('400s when humanVerdict is missing entirely', async () => {
            const card = await createCard();
            const { status } = await judge(card.id, { rejectionReason: 'other' });
            expect(status).toBe(400);
        });

        it('404s on an unknown cardId', async () => {
            const { status, body } = await judge('no-such-card-id', {
                humanVerdict: 'looks-right',
            });

            expect(status).toBe(404);
            expect(body.error).toBe('Verification card not found');
        });

        it('validates the verdict before it looks the card up', async () => {
            // Ordering matters: a bad payload against a missing card should
            // report the payload problem, not the missing card.
            const { status, body } = await judge('no-such-card-id', {
                humanVerdict: 'nonsense',
            });
            expect(status).toBe(400);
            expect(body.error).toMatch(/humanVerdict must be/);
        });

        it('truncates a rejectionNote longer than 500 chars to exactly 500', async () => {
            const card = await createCard();
            const longNote = 'x'.repeat(900);

            const { status, body } = await judge(card.id, {
                humanVerdict: 'looks-wrong',
                rejectionReason: 'other',
                rejectionNote: longNote,
            });

            expect(status).toBe(200);
            expect(body.rejectionNote).toHaveLength(500);
            expect(body.rejectionNote).toBe('x'.repeat(500));

            const fetched = await h.req<VerificationCard>(`/api/verifications/${card.id}`);
            expect(fetched.body.rejectionNote).toHaveLength(500);
        });

        it('leaves a note of exactly 500 chars untouched', async () => {
            const card = await createCard();
            const note = 'y'.repeat(500);

            const { body } = await judge(card.id, {
                humanVerdict: 'looks-wrong',
                rejectionReason: 'other',
                rejectionNote: note,
            });

            expect(body.rejectionNote).toBe(note);
        });

        it('ignores a non-string rejectionNote rather than 500ing', async () => {
            const card = await createCard();

            const { status, body } = await judge(card.id, {
                humanVerdict: 'looks-wrong',
                rejectionReason: 'other',
                rejectionNote: { not: 'a string' },
            });

            expect(status).toBe(200);
            expect(body.rejectionNote).toBeUndefined();
        });

        it('returns notified:false when notify is false, and does not mark the card', async () => {
            const card = await createCard();

            const { status, body } = await judge(card.id, {
                humanVerdict: 'looks-right',
                notify: false,
            });

            expect(status).toBe(200);
            expect(body.notified).toBe(false);
            // Opting out must not consume the one-shot notify guard, otherwise a
            // later push for the same card would be silently swallowed.
            expect(body.notifiedAt).toBeUndefined();

            const fetched = await h.req<VerificationCard>(`/api/verifications/${card.id}`);
            expect(fetched.body.notifiedAt).toBeUndefined();
            expect(fetched.body.humanVerdict).toBe('looks-right');
        });

        it('still notifies when notify is omitted or explicitly true', async () => {
            const omitted = await createCard();
            const r1 = await judge(omitted.id, { humanVerdict: 'looks-right' });
            expect(r1.body.notified).toBe(true);

            const explicit = await createCard();
            const r2 = await judge(explicit.id, { humanVerdict: 'looks-right', notify: true });
            expect(r2.body.notified).toBe(true);
        });

        it('only notifies once per card - re-judging returns notified:false', async () => {
            const card = await createCard();

            const first = await judge(card.id, {
                humanVerdict: 'looks-wrong',
                rejectionReason: 'nothing-rendered',
            });
            expect(first.status).toBe(200);
            expect(first.body.notified).toBe(true);
            expect(first.body.notifiedAt).toBeTruthy();

            // markNotified is the idempotency guard: a second judgement is still
            // recorded, but must not push into the session again.
            const second = await judge(card.id, { humanVerdict: 'looks-right' });
            expect(second.status).toBe(200);
            expect(second.body.notified).toBe(false);
            expect(second.body.humanVerdict).toBe('looks-right');
        });

        it('clears rejectionReason/rejectionNote when re-judged as looks-right', async () => {
            const card = await createCard();

            await judge(card.id, {
                humanVerdict: 'looks-wrong',
                rejectionReason: 'visual-glitch',
                rejectionNote: 'colours are inverted',
            });

            const { status, body } = await judge(card.id, { humanVerdict: 'looks-right' });

            expect(status).toBe(200);
            expect(body.humanVerdict).toBe('looks-right');
            expect(body.rejectionReason).toBeUndefined();
            expect(body.rejectionNote).toBeUndefined();

            // And the stale reason must not survive on disk either.
            const fetched = await h.req<VerificationCard>(`/api/verifications/${card.id}`);
            expect(fetched.body.rejectionReason).toBeUndefined();
            expect(fetched.body.rejectionNote).toBeUndefined();
        });

        it('does not 500 when the card belongs to a task that is not running', async () => {
            // notifyTaskOfVerdict writes into a task that has no live PTY here.
            // The push is best-effort by design; the phone must still get a 200.
            const card = await createCard();

            const { status, body } = await judge(card.id, {
                humanVerdict: 'looks-wrong',
                rejectionReason: 'other',
            });

            expect(status).toBe(200);
            expect(body.humanVerdict).toBe('looks-wrong');
            expect(typeof body.notified).toBe('boolean');
        });

        it('refuses to file a card against a task that does not exist', async () => {
            // The judge route pushes into card.taskId's session, so an
            // unvalidated taskId here would be a write primitive into any
            // other task. The guard lives at creation time.
            const { status } = await h.send('POST', '/api/verifications', {
                taskId: 'task-that-does-not-exist',
                workspaceId: WORKSPACE_ID,
                claim: 'forged attribution',
                capturer: 'manual',
                imagePath,
            });
            expect(status).toBe(404);
        });

        it('refuses an oversized claim', async () => {
            // The claim is agent-authored and lands in a message pasted into a
            // session; it must not be unbounded.
            const { status } = await h.send('POST', '/api/verifications', {
                taskId: TASK_ID,
                workspaceId: WORKSPACE_ID,
                claim: 'x'.repeat(2001),
                capturer: 'manual',
                imagePath,
            });
            expect(status).toBe(400);
        });
    });

    describe('GET /api/verifications', () => {
        it('excludes judged cards from ?pending=true', async () => {
            const toJudge = await createCard({ claim: 'judged claim' });
            const pendingCard = await createCard({ claim: 'still pending claim' });

            const before = await h.req<VerificationCard[]>('/api/verifications?pending=true');
            expect(before.status).toBe(200);
            expect(before.body.map(c => c.id).sort())
                .toEqual([toJudge.id, pendingCard.id].sort());

            await judge(toJudge.id, { humanVerdict: 'looks-right', notify: false });

            const after = await h.req<VerificationCard[]>('/api/verifications?pending=true');
            expect(after.status).toBe(200);
            const ids = after.body.map(c => c.id);
            expect(ids).not.toContain(toJudge.id);
            expect(ids).toContain(pendingCard.id);
        });

        it('excludes cards whose verdict is not needs-human-eyes from pending', async () => {
            await createCard({ verdict: 'pass', claim: 'auto-passed' });
            const needsEyes = await createCard({ claim: 'needs eyes' });

            const { body } = await h.req<VerificationCard[]>('/api/verifications?pending=true');
            expect(body.map(c => c.id)).toEqual([needsEyes.id]);
        });

        it('still lists judged cards in the unfiltered feed', async () => {
            const card = await createCard();
            await judge(card.id, { humanVerdict: 'looks-right', notify: false });

            const { status, body } = await h.req<VerificationCard[]>('/api/verifications');
            expect(status).toBe(200);
            expect(body.map(c => c.id)).toContain(card.id);
        });

        it('filters by taskId', async () => {
            const mine = await createCard();
            // Must be a task the harness actually knows about - cards can only
            // be filed against a real task now.
            await createCard({ taskId: OTHER_TASK_ID });

            const { body } = await h.req<VerificationCard[]>(
                `/api/verifications?taskId=${TASK_ID}`,
            );
            expect(body.map(c => c.id)).toEqual([mine.id]);
        });

        it('scopes pending by workspaceId', async () => {
            const mine = await createCard();
            await createCard({ workspaceId: 'ws-elsewhere' });

            const { body } = await h.req<VerificationCard[]>(
                `/api/verifications?pending=true&workspaceId=${WORKSPACE_ID}`,
            );
            expect(body.map(c => c.id)).toEqual([mine.id]);
        });
    });

    describe('GET /api/verifications/evidence/:filename', () => {
        it('serves a real evidence file', async () => {
            const card = await createCard();
            expect(card.evidence).toHaveLength(1);

            const res = await h.fetch(`/api/verifications/evidence/${card.evidence[0].filename}`);
            expect(res.status).toBe(200);
            const bytes = Buffer.from(await res.arrayBuffer());
            expect(bytes.equals(PNG_BYTES)).toBe(true);
        });

        it('404s on traversal filenames and serves nothing outside the evidence dir', async () => {
            // A canary one level above evidence/. If traversal worked, this is
            // the sort of thing that would leak, and its contents are unique
            // enough to assert on.
            const CANARY = 'CANARY-SECRET-DO-NOT-SERVE';
            writeFileSync(join(h.base, 'secret.txt'), CANARY);
            expect(existsSync(join(h.base, 'secret.txt'))).toBe(true);

            const traversals = [
                '..%2F..%2Fetc%2Fpasswd',
                '..%2Fsecret.txt',
                '%2Fetc%2Fpasswd',
                '..%5C..%5Cwindows%5Cwin.ini',
                'foo%2F..%2F..%2Fsecret.txt',
                '..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd',
            ];

            for (const name of traversals) {
                const res = await h.fetch(`/api/verifications/evidence/${name}`);
                expect(res.status, `${name} should not be served`).toBe(404);
                const text = await res.text();
                expect(text, `${name} leaked file contents`).not.toContain(CANARY);
                expect(text).not.toContain('root:');
            }
        });

        it('404s on an unknown but well-formed filename', async () => {
            const res = await h.fetch('/api/verifications/evidence/not-a-real-file.png');
            expect(res.status).toBe(404);
        });

        it('does not let /evidence/ be swallowed by the /:cardId route', async () => {
            // Declaration order matters: if /:cardId won, this would 404 with the
            // card-not-found body instead of the evidence-not-found one.
            const { status, body } = await h.req<{ error: string }>(
                '/api/verifications/evidence/nope.png',
            );
            expect(status).toBe(404);
            expect(body.error).toBe('Evidence not found');
        });

        it('deleting a card removes its evidence from disk and from the route', async () => {
            const card = await createCard();
            const filename = card.evidence[0].filename;
            expect(existsSync(join(h.base, 'evidence', filename))).toBe(true);

            const del = await h.send('DELETE', `/api/verifications/${card.id}`);
            expect(del.status).toBe(200);

            expect(existsSync(join(h.base, 'evidence', filename))).toBe(false);
            const res = await h.fetch(`/api/verifications/evidence/${filename}`);
            expect(res.status).toBe(404);
            // Nothing orphaned behind.
            expect(readdirSync(join(h.base, 'evidence'))).not.toContain(filename);
        });
    });

    describe('POST /api/verifications (seeding surface)', () => {
        it('400s without taskId or claim', async () => {
            const a = await h.send<{ error: string }>('POST', '/api/verifications', {
                claim: 'no task id',
                capturer: 'manual',
                imagePath,
            });
            expect(a.status).toBe(400);
            expect(a.body.error).toMatch(/taskId and claim are required/);

            const b = await h.send<{ error: string }>('POST', '/api/verifications', {
                taskId: TASK_ID,
                capturer: 'manual',
                imagePath,
            });
            expect(b.status).toBe(400);
        });

        it('400s when capturer is manual but imagePath does not exist', async () => {
            const { status, body } = await h.send<{ error: string }>('POST', '/api/verifications', {
                taskId: TASK_ID,
                claim: 'missing image',
                capturer: 'manual',
                imagePath: join(h.base, 'nope-not-here.png'),
            });
            expect(status).toBe(400);
            expect(body.error).toMatch(/imagePath/);
        });
    });
});
