/**
 * Verification Store - Persists visual verification cards and their evidence.
 *
 * A verification card pairs a claim ("the coin pickup plays its animation")
 * with the screenshots that back it up and a verdict. Cards are the unit shown
 * in the mobile visual feed.
 *
 * Storage layout:
 *   <basePath>/verifications.json        - card metadata (versioned)
 *   <basePath>/evidence/<filename>.png   - the image bytes
 *
 * Note this is deliberately NOT the same directory as the transient image
 * uploads in server.ts: those are user->agent attachments cleaned up after 24h,
 * whereas evidence is the durable audit trail behind a verification and is
 * pruned by count, not age.
 */
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import type {
    VerificationCard,
    VisualEvidence,
    VerificationVerdict,
    HumanVerdict,
    RejectionReason,
    CapturerId,
} from '@claudia/shared';
import { loadVersioned, saveVersioned } from './utils/schema-version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VERIFICATION_SCHEMA_VERSION = 1;

/**
 * Max cards retained per task. Screenshots are far larger than the text
 * history this codebase usually deals with, so retention is by count and
 * evidence files are deleted alongside their card.
 */
const MAX_CARDS_PER_TASK = 50;

interface VerificationData {
    cards: VerificationCard[];
}

function getDefaultData(): VerificationData {
    return { cards: [] };
}

export interface CreateCardInput {
    taskId: string;
    workspaceId: string;
    claim: string;
    verdict: VerificationVerdict;
    capturer: CapturerId;
    notes?: string;
    checkpointId?: string;
    target?: string;
    viewport?: { width: number; height: number };
    /** Images to store as evidence, as raw PNG buffers. */
    images: Array<{ buffer: Buffer; label?: string; width?: number; height?: number }>;
}

export class VerificationStore {
    private data: VerificationData;
    private filePath: string;
    private evidenceDir: string;

    constructor(basePath?: string) {
        const base = basePath || join(__dirname, '..');
        this.filePath = join(base, 'verifications.json');
        this.evidenceDir = join(base, 'evidence');

        for (const dir of [dirname(this.filePath), this.evidenceDir]) {
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
        }

        this.data = this.loadData();
        console.log(
            `[VerificationStore] Loaded ${this.data.cards.length} verification cards from ${this.filePath}`,
        );
        console.log(`[VerificationStore] Evidence directory: ${this.evidenceDir}`);
    }

    private loadData(): VerificationData {
        try {
            return loadVersioned<VerificationData>(this.filePath, {
                currentVersion: VERIFICATION_SCHEMA_VERSION,
                defaultData: getDefaultData(),
                legacyLoader: (raw) => (raw as VerificationData) ?? getDefaultData(),
            });
        } catch (error) {
            console.error('[VerificationStore] Error loading data:', error);
            return getDefaultData();
        }
    }

    private save(): void {
        try {
            saveVersioned(this.filePath, this.data, VERIFICATION_SCHEMA_VERSION);
        } catch (error) {
            console.error('[VerificationStore] Error saving data:', error);
            throw error;
        }
    }

    /** Absolute path to an evidence file, or null if it is missing. */
    getEvidencePath(filename: string): string | null {
        // Guard against traversal - filenames are generated, never user-supplied,
        // but this is a file-serving path so validate anyway.
        if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
            return null;
        }
        const p = join(this.evidenceDir, filename);
        return existsSync(p) ? p : null;
    }

    /**
     * Create a verification card, writing its evidence images to disk.
     */
    createCard(input: CreateCardInput): VerificationCard {
        const cardId = randomUUID();
        const evidence: VisualEvidence[] = [];

        for (const [index, image] of input.images.entries()) {
            const evidenceId = randomUUID();
            const filename = `${cardId}-${index}-${evidenceId.slice(0, 8)}.png`;
            const fullPath = join(this.evidenceDir, filename);
            try {
                writeFileSync(fullPath, image.buffer);
            } catch (error) {
                console.error(`[VerificationStore] Failed to write evidence ${filename}:`, error);
                continue;
            }
            evidence.push({
                id: evidenceId,
                filename,
                label: image.label,
                width: image.width,
                height: image.height,
                bytes: image.buffer.length,
            });
        }

        const card: VerificationCard = {
            id: cardId,
            taskId: input.taskId,
            workspaceId: input.workspaceId,
            checkpointId: input.checkpointId,
            claim: input.claim,
            notes: input.notes,
            verdict: input.verdict,
            capturer: input.capturer,
            evidence,
            viewport: input.viewport,
            target: input.target,
            timestamp: new Date().toISOString(),
        };

        this.data.cards.push(card);
        this.pruneTask(input.taskId);
        this.save();

        console.log(
            `[VerificationStore] Created card ${cardId} for task ${input.taskId} ` +
            `(verdict=${card.verdict}, capturer=${card.capturer}, evidence=${evidence.length})`,
        );
        return card;
    }

    /** Drop oldest cards for a task beyond the retention cap, deleting their files. */
    private pruneTask(taskId: string): void {
        const taskCards = this.data.cards
            .filter((c) => c.taskId === taskId)
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

        if (taskCards.length <= MAX_CARDS_PER_TASK) return;

        const excess = taskCards.slice(0, taskCards.length - MAX_CARDS_PER_TASK);
        for (const card of excess) {
            this.deleteEvidenceFiles(card);
        }
        const excessIds = new Set(excess.map((c) => c.id));
        this.data.cards = this.data.cards.filter((c) => !excessIds.has(c.id));
        console.log(
            `[VerificationStore] Pruned ${excess.length} old card(s) for task ${taskId}`,
        );
    }

    private deleteEvidenceFiles(card: VerificationCard): void {
        for (const ev of card.evidence) {
            const p = join(this.evidenceDir, ev.filename);
            try {
                if (existsSync(p)) unlinkSync(p);
            } catch (error) {
                console.error(`[VerificationStore] Failed to delete ${ev.filename}:`, error);
            }
        }
    }

    getCard(cardId: string): VerificationCard | undefined {
        return this.data.cards.find((c) => c.id === cardId);
    }

    /** Cards for one task, newest first. */
    getCardsForTask(taskId: string): VerificationCard[] {
        return this.data.cards
            .filter((c) => c.taskId === taskId)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }

    /**
     * The mobile feed: cards across a workspace, newest first.
     * Omit workspaceId to get everything (useful for a global feed).
     */
    getFeed(workspaceId?: string, limit = 100): VerificationCard[] {
        return this.data.cards
            .filter((c) => !workspaceId || c.workspaceId === workspaceId)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, limit);
    }

    /** Cards awaiting a human decision. */
    getPending(workspaceId?: string): VerificationCard[] {
        return this.getFeed(workspaceId, 500).filter(
            (c) => c.verdict === 'needs-human-eyes' && !c.humanVerdict,
        );
    }

    /** Record the user's judgement from the mobile feed. */
    judgeCard(
        cardId: string,
        humanVerdict: HumanVerdict,
        rejection?: { reason?: RejectionReason; note?: string },
    ): VerificationCard | undefined {
        const card = this.getCard(cardId);
        if (!card) return undefined;
        card.humanVerdict = humanVerdict;
        card.humanVerdictAt = new Date().toISOString();

        // A reason only means anything against a rejection. Clearing it on
        // 'looks-right' keeps a re-judged card from carrying a stale reason.
        if (humanVerdict === 'looks-wrong') {
            card.rejectionReason = rejection?.reason;
            card.rejectionNote = rejection?.note;
        } else {
            delete card.rejectionReason;
            delete card.rejectionNote;
        }

        this.save();
        console.log(
            `[VerificationStore] Card ${cardId} judged: ${humanVerdict}` +
            (card.rejectionReason ? ` (${card.rejectionReason})` : ''),
        );
        return card;
    }

    /**
     * Mark that the judgement was delivered back to the task.
     *
     * Returns false if it was already marked - the caller uses that to avoid
     * notifying twice when a card is re-judged or two paths race.
     */
    markNotified(cardId: string): boolean {
        const card = this.getCard(cardId);
        if (!card || card.notifiedAt) return false;
        card.notifiedAt = new Date().toISOString();
        this.save();
        return true;
    }

    deleteCard(cardId: string): boolean {
        const card = this.getCard(cardId);
        if (!card) return false;
        this.deleteEvidenceFiles(card);
        this.data.cards = this.data.cards.filter((c) => c.id !== cardId);
        this.save();
        console.log(`[VerificationStore] Deleted card ${cardId}`);
        return true;
    }

    /** Remove all cards for a task (called when a task is deleted). */
    deleteCardsForTask(taskId: string): number {
        const cards = this.data.cards.filter((c) => c.taskId === taskId);
        for (const card of cards) this.deleteEvidenceFiles(card);
        this.data.cards = this.data.cards.filter((c) => c.taskId !== taskId);
        if (cards.length > 0) {
            this.save();
            console.log(`[VerificationStore] Deleted ${cards.length} card(s) for task ${taskId}`);
        }
        return cards.length;
    }

    /** Read an evidence file as a base64 data URL (used by the mobile feed). */
    readEvidenceAsDataUrl(filename: string): string | null {
        const p = this.getEvidencePath(filename);
        if (!p) return null;
        try {
            return `data:image/png;base64,${readFileSync(p).toString('base64')}`;
        } catch (error) {
            console.error(`[VerificationStore] Failed to read ${filename}:`, error);
            return null;
        }
    }
}
