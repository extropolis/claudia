/**
 * sdkTaskStore — frontend state for SDK-driven tasks.
 *
 * Keeps:
 *   - pending permission requests per task (for the dialog)
 *   - last completion summary per task (for the "Run complete" footer)
 *
 * The conversation events themselves live in conversationStore — same as
 * existing JSONL-streamed tasks. This store is just the SDK-specific bits.
 */
import { create } from 'zustand';

export interface SdkPermissionRequest {
  taskId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  receivedAt: string;
}

export interface SdkRunSummary {
  isError: boolean;
  numTurns?: number;
  totalCostUsd?: number;
  durationMs?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface SdkTaskState {
  pendingByTask: Record<string, SdkPermissionRequest[]>;
  lastSummaryByTask: Record<string, SdkRunSummary>;

  addPermission(req: SdkPermissionRequest): void;
  resolvePermission(taskId: string, requestId: string): void;
  setSummary(taskId: string, summary: SdkRunSummary): void;
  clearTask(taskId: string): void;
}

export const useSdkTaskStore = create<SdkTaskState>((set) => ({
  pendingByTask: {},
  lastSummaryByTask: {},

  addPermission: (req) =>
    set((state) => {
      const list = state.pendingByTask[req.taskId] ?? [];
      // Dedup on requestId in case the same WS event arrives twice (e.g. on
      // reconnect seed + a regular broadcast).
      if (list.some((r) => r.requestId === req.requestId)) return state;
      return {
        pendingByTask: {
          ...state.pendingByTask,
          [req.taskId]: [...list, req],
        },
      };
    }),

  resolvePermission: (taskId, requestId) =>
    set((state) => {
      const list = state.pendingByTask[taskId];
      if (!list) return state;
      const next = list.filter((r) => r.requestId !== requestId);
      const updated = { ...state.pendingByTask };
      if (next.length === 0) delete updated[taskId];
      else updated[taskId] = next;
      return { pendingByTask: updated };
    }),

  setSummary: (taskId, summary) =>
    set((state) => ({
      lastSummaryByTask: { ...state.lastSummaryByTask, [taskId]: summary },
    })),

  clearTask: (taskId) =>
    set((state) => {
      const pending = { ...state.pendingByTask };
      const summaries = { ...state.lastSummaryByTask };
      delete pending[taskId];
      delete summaries[taskId];
      return { pendingByTask: pending, lastSummaryByTask: summaries };
    }),
}));

/** Hook: pending permissions for a task, updates as they arrive/resolve. */
export function useSdkPendingPermissions(taskId: string | null | undefined): SdkPermissionRequest[] {
  return useSdkTaskStore((s) => (taskId ? s.pendingByTask[taskId] ?? EMPTY : EMPTY));
}

const EMPTY: SdkPermissionRequest[] = [];

/** Hook: last run summary, useful for the chat footer. */
export function useSdkSummary(taskId: string | null | undefined): SdkRunSummary | undefined {
  return useSdkTaskStore((s) => (taskId ? s.lastSummaryByTask[taskId] : undefined));
}
