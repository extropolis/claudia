/**
 * Learnings Store - Vector-based storage for learned patterns
 *
 * Uses embeddings via the local proxy for semantic search.
 * Stores learnings with title, content, and embeddings for semantic search.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ConfigStore } from './config-store.js';
import { PORTS } from '@claudia/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * A single learning entry
 */
export interface Learning {
    id: string;
    workspaceId: string;
    title: string;
    content: string;
    embedding: number[];
    createdAt: string;
    updatedAt: string;
    sourceTaskId?: string;  // The task this learning came from
    utility: number;        // MemRL utility score [0, 1]
    useCount: number;       // How many times this learning was retrieved
    successCount: number;   // How many times retrieval led to success
}

/**
 * Storage format
 */
interface LearningsData {
    learnings: Learning[];
    version: number;
}

/**
 * Search result with relevance score
 */
export interface LearningSearchResult {
    learning: Learning;
    score: number;  // Cosine similarity score
}

/**
 * LearningsStore manages vector-based storage and retrieval of learned patterns
 */
export class LearningsStore {
    private data: LearningsData;
    private storagePath: string;
    private configStore: ConfigStore;
    private embeddingModel: string;

    constructor(basePath?: string, configStore?: ConfigStore) {
        this.storagePath = basePath
            ? join(basePath, 'learnings.json')
            : join(__dirname, '..', 'learnings.json');

        this.configStore = configStore || new ConfigStore(basePath);
        this.embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-ada-002';

        this.data = this.loadData();
        console.log(`[LearningsStore] Loaded ${this.data.learnings.length} learnings`);
    }

    private loadData(): LearningsData {
        try {
            if (existsSync(this.storagePath)) {
                const raw = readFileSync(this.storagePath, 'utf-8');
                return JSON.parse(raw);
            }
        } catch (error) {
            console.error('[LearningsStore] Failed to load data:', error);
        }
        return { learnings: [], version: 1 };
    }

    private saveData(): void {
        try {
            const dir = dirname(this.storagePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(this.storagePath, JSON.stringify(this.data, null, 2));
        } catch (error) {
            console.error('[LearningsStore] Failed to save data:', error);
        }
    }

    /**
     * Generate embeddings via the local proxy
     */
    async generateEmbedding(text: string): Promise<number[]> {
        const url = `http://localhost:${PORTS.BACKEND}/v1/embeddings`;

        console.log(`[LearningsStore] Generating embedding for text (${text.length} chars)...`);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.embeddingModel,
                input: text
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Embedding API error: ${response.status} - ${errorText}`);
        }

        const data = await response.json() as {
            data: Array<{ embedding: number[] }>;
        };

        if (!data.data?.[0]?.embedding) {
            throw new Error('No embedding in response');
        }

        console.log(`[LearningsStore] Generated embedding with ${data.data[0].embedding.length} dimensions`);
        return data.data[0].embedding;
    }

    /**
     * Calculate cosine similarity between two embeddings
     */
    private cosineSimilarity(a: number[], b: number[]): number {
        if (a.length !== b.length) {
            // Handle dimension mismatch by padding shorter array (without mutating originals)
            const maxLen = Math.max(a.length, b.length);
            a = [...a];
            b = [...b];
            while (a.length < maxLen) a.push(0);
            while (b.length < maxLen) b.push(0);
        }

        let dotProduct = 0;
        let magA = 0;
        let magB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            magA += a[i] * a[i];
            magB += b[i] * b[i];
        }

        magA = Math.sqrt(magA);
        magB = Math.sqrt(magB);

        if (magA === 0 || magB === 0) return 0;
        return dotProduct / (magA * magB);
    }

    /**
     * Add a new learning
     */
    async addLearning(params: {
        workspaceId: string;
        title: string;
        content: string;
        sourceTaskId?: string;
    }): Promise<Learning> {
        const id = `learning-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date().toISOString();

        // Generate embedding for the combined title + content
        const textForEmbedding = `${params.title}\n\n${params.content}`;
        const embedding = await this.generateEmbedding(textForEmbedding);

        const learning: Learning = {
            id,
            workspaceId: params.workspaceId,
            title: params.title,
            content: params.content,
            embedding,
            createdAt: now,
            updatedAt: now,
            sourceTaskId: params.sourceTaskId,
            utility: 0.5,  // Initial utility score
            useCount: 0,
            successCount: 0
        };

        this.data.learnings.push(learning);
        this.saveData();

        console.log(`[LearningsStore] Added learning: ${learning.title} (${learning.id})`);
        return learning;
    }

    /**
     * Search for relevant learnings using semantic similarity
     */
    async searchLearnings(params: {
        query: string;
        workspaceId?: string;
        topK?: number;
        minScore?: number;
        useUtilityRanking?: boolean;
    }): Promise<LearningSearchResult[]> {
        const {
            query,
            workspaceId,
            topK = 5,
            minScore = 0.3,
            useUtilityRanking = true
        } = params;

        // Generate query embedding
        const queryEmbedding = await this.generateEmbedding(query);

        // Filter by workspace if specified
        let candidates = this.data.learnings;
        if (workspaceId) {
            candidates = candidates.filter(l => l.workspaceId === workspaceId);
        }

        // Calculate similarity scores
        const results: LearningSearchResult[] = [];
        for (const learning of candidates) {
            if (!learning.embedding) continue;

            const similarity = this.cosineSimilarity(queryEmbedding, learning.embedding);
            if (similarity >= minScore) {
                results.push({
                    learning,
                    score: similarity
                });
            }
        }

        // Sort by score (and optionally incorporate utility)
        if (useUtilityRanking) {
            // MemRL-style: combine similarity with utility
            // Final score = similarity * 0.6 + utility * 0.4
            results.sort((a, b) => {
                const scoreA = a.score * 0.6 + a.learning.utility * 0.4;
                const scoreB = b.score * 0.6 + b.learning.utility * 0.4;
                return scoreB - scoreA;
            });
        } else {
            results.sort((a, b) => b.score - a.score);
        }

        return results.slice(0, topK);
    }

    /**
     * Get all learnings for a workspace
     */
    getLearnings(workspaceId?: string): Learning[] {
        if (workspaceId) {
            return this.data.learnings.filter(l => l.workspaceId === workspaceId);
        }
        return [...this.data.learnings];
    }

    /**
     * Get a single learning by ID
     */
    getLearning(id: string): Learning | undefined {
        return this.data.learnings.find(l => l.id === id);
    }

    /**
     * Update a learning's utility based on task outcome (MemRL)
     */
    updateUtility(id: string, success: boolean, learningRate: number = 0.1): void {
        const learning = this.data.learnings.find(l => l.id === id);
        if (!learning) return;

        const reward = success ? 1.0 : 0.0;
        learning.utility = learning.utility + learningRate * (reward - learning.utility);
        learning.useCount += 1;
        if (success) learning.successCount += 1;
        learning.updatedAt = new Date().toISOString();

        this.saveData();
        console.log(`[LearningsStore] Updated utility for ${id}: ${learning.utility.toFixed(3)} (${success ? 'success' : 'failure'})`);
    }

    /**
     * Record that a learning was retrieved (for tracking)
     */
    recordRetrieval(ids: string[]): void {
        for (const id of ids) {
            const learning = this.data.learnings.find(l => l.id === id);
            if (learning) {
                learning.useCount += 1;
                learning.updatedAt = new Date().toISOString();
            }
        }
        this.saveData();
    }

    /**
     * Delete a learning
     */
    deleteLearning(id: string): boolean {
        const idx = this.data.learnings.findIndex(l => l.id === id);
        if (idx === -1) return false;

        this.data.learnings.splice(idx, 1);
        this.saveData();
        console.log(`[LearningsStore] Deleted learning: ${id}`);
        return true;
    }

    /**
     * Update a learning's title/content (regenerates embedding)
     */
    async updateLearning(id: string, updates: { title?: string; content?: string }): Promise<Learning | null> {
        const learning = this.data.learnings.find(l => l.id === id);
        if (!learning) return null;

        if (updates.title !== undefined) learning.title = updates.title;
        if (updates.content !== undefined) learning.content = updates.content;

        // Regenerate embedding
        const textForEmbedding = `${learning.title}\n\n${learning.content}`;
        learning.embedding = await this.generateEmbedding(textForEmbedding);
        learning.updatedAt = new Date().toISOString();

        this.saveData();
        console.log(`[LearningsStore] Updated learning: ${id}`);
        return learning;
    }

    /**
     * Format learnings for injection into conversation context
     */
    formatForContext(learnings: LearningSearchResult[]): string {
        if (learnings.length === 0) return '';

        const lines = ['[RELEVANT LEARNINGS]', ''];

        for (const { learning, score } of learnings) {
            lines.push(`## ${learning.title}`);
            lines.push(learning.content);
            lines.push(`(Relevance: ${(score * 100).toFixed(0)}%, Utility: ${(learning.utility * 100).toFixed(0)}%)`);
            lines.push('');
        }

        lines.push('[/RELEVANT LEARNINGS]');
        return lines.join('\n');
    }
}
