/**
 * Mobile Chat Store — Per-workspace chat transcript for the mobile companion.
 *
 * Each workspace has its own conversation between the user and the "mobile
 * agent" (see mobile-agent.ts). Messages are persisted in a single JSON file
 * (`mobile-chat-history.json`) so transcripts survive backend restarts and
 * are visible across multiple paired devices.
 *
 * Cap: each workspace's transcript is pruned to MAX_MESSAGES_PER_WORKSPACE
 * to avoid unbounded growth. Oldest messages drop first.
 */

import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import type { MobileChatMessage } from '@claudia/shared';

import { loadVersioned, saveVersioned } from './utils/schema-version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_VERSION = 1;
const MAX_MESSAGES_PER_WORKSPACE = 200;

interface MobileChatData {
  // workspaceId → messages (oldest first)
  transcripts: Record<string, MobileChatMessage[]>;
}

function getDefaultData(): MobileChatData {
  return { transcripts: {} };
}

export interface AppendMessageInput {
  workspaceId: string;
  role: MobileChatMessage['role'];
  text: string;
  taskId?: string;
  quickActions?: MobileChatMessage['quickActions'];
}

export class MobileChatStore {
  private data: MobileChatData;
  private filePath: string;
  private saveScheduled = false;

  constructor(basePath?: string) {
    this.filePath = basePath
      ? join(basePath, 'mobile-chat-history.json')
      : join(__dirname, '..', 'mobile-chat-history.json');

    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.data = this.loadData();
    const totalMessages = Object.values(this.data.transcripts).reduce(
      (acc, msgs) => acc + msgs.length,
      0,
    );
    console.log(
      `[MobileChatStore] Loaded ${totalMessages} messages across ${Object.keys(this.data.transcripts).length} workspace(s) from ${this.filePath}`,
    );
  }

  private loadData(): MobileChatData {
    try {
      return loadVersioned<MobileChatData>(this.filePath, {
        currentVersion: SCHEMA_VERSION,
        defaultData: getDefaultData(),
        legacyLoader: (raw) => (raw as MobileChatData) ?? getDefaultData(),
      });
    } catch (err) {
      console.error('[MobileChatStore] Error loading data:', err);
      return getDefaultData();
    }
  }

  private save(): void {
    try {
      saveVersioned(this.filePath, this.data, SCHEMA_VERSION);
    } catch (err) {
      console.error('[MobileChatStore] Error saving data:', err);
    }
  }

  /**
   * Coalesce frequent saves (e.g. multiple appends in one agent turn) into a
   * single disk write per tick. The store always keeps in-memory state
   * authoritative — the file write is a durability concern.
   */
  private scheduleSave(): void {
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setImmediate(() => {
      this.saveScheduled = false;
      this.save();
    });
  }

  /**
   * Append a message to a workspace's transcript. Returns the stored message
   * (with id + timestamp populated by the store).
   */
  appendMessage(input: AppendMessageInput): MobileChatMessage {
    const message: MobileChatMessage = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      role: input.role,
      text: input.text,
      taskId: input.taskId,
      quickActions: input.quickActions,
      createdAt: new Date().toISOString(),
    };

    const list = this.data.transcripts[input.workspaceId] ?? [];
    list.push(message);

    // Prune oldest if over cap
    const overflow = list.length - MAX_MESSAGES_PER_WORKSPACE;
    if (overflow > 0) {
      list.splice(0, overflow);
    }

    this.data.transcripts[input.workspaceId] = list;
    this.scheduleSave();
    console.log(
      `[MobileChatStore] +${input.role} message in ws=${input.workspaceId} (now ${list.length} msgs, taskId=${input.taskId ?? '-'}, actions=${input.quickActions?.length ?? 0})`,
    );
    return message;
  }

  /**
   * Get the transcript for a workspace, oldest first. Returns a copy.
   */
  getTranscript(workspaceId: string): MobileChatMessage[] {
    const list = this.data.transcripts[workspaceId];
    return list ? [...list] : [];
  }

  /**
   * Get the most recent N messages for a workspace, oldest first. Used to
   * feed conversation context to the agent.
   */
  getRecentMessages(workspaceId: string, count: number): MobileChatMessage[] {
    const list = this.data.transcripts[workspaceId] ?? [];
    if (list.length <= count) return [...list];
    return list.slice(list.length - count);
  }

  /**
   * Wipe a workspace's transcript. Returns true if anything was removed.
   */
  clear(workspaceId: string): boolean {
    if (!this.data.transcripts[workspaceId]) return false;
    delete this.data.transcripts[workspaceId];
    this.scheduleSave();
    console.log(`[MobileChatStore] Cleared transcript for ws=${workspaceId}`);
    return true;
  }

  /**
   * Drop all transcripts. Mainly used by tests.
   */
  clearAll(): void {
    this.data = getDefaultData();
    this.scheduleSave();
  }
}
