/**
 * conversationStore — per-task ConversationEvent timeline for the React
 * conversation view. The view component subscribes to selectors here; the
 * WS hook (useWebSocket.ts) feeds events in.
 *
 * Why a separate store from taskStore? taskStore is hot (every keystroke,
 * every state-change broadcast goes through it); the conversation event
 * stream is its own dimension and we don't want every conversation event
 * to invalidate every taskStore selector.
 *
 * Optimistic messages: Claude Code only flushes its JSONL writes at turn
 * boundaries (when an assistant turn completes), so there's a multi-second
 * gap between a user pressing Enter and their message appearing in the
 * feed. We close that gap by emitting an optimistic `user_message` event
 * locally as soon as the user submits — uuid prefixed `optimistic:`. When
 * the real event arrives later (from the JSONL streamer), we replace the
 * optimistic placeholder by content-matching on `text + recent timestamp`.
 */
import { create } from 'zustand';
import type { ConversationEvent } from '@claudia/shared';

const OPTIMISTIC_PREFIX = 'optimistic:';

interface ConversationState {
  /** Per-task event timelines, keyed by taskId. */
  eventsByTask: Record<string, ConversationEvent[]>;

  /** Append a single live event (deduped by uuid). If this event matches an
   *  outstanding optimistic placeholder (same role + text), the placeholder
   *  is replaced rather than the new event being appended alongside. */
  appendEvent: (taskId: string, event: ConversationEvent) => void;

  /** Replace a task's timeline with a snapshot — used on WS reconnect/restore
   *  and for cold loads from the REST endpoint. Idempotent. */
  setEventsForTask: (taskId: string, events: ConversationEvent[]) => void;

  /** Append an optimistic user_message instantly (for the input-bar UX).
   *  Returns the uuid so the caller can correlate. The event will be
   *  replaced by the real one when JSONL flushes. */
  appendOptimisticUserMessage: (taskId: string, text: string) => string;

  /** Drop a task's timeline (called on task:destroyed). */
  clearTask: (taskId: string) => void;
}

/** Match an optimistic user message to an incoming real user_message event.
 *  Two-step heuristic: same role + same trimmed text. We compare the most
 *  recent optimistic entries because users may queue prompts in quick
 *  succession. */
function findMatchingOptimisticIndex(
  events: ConversationEvent[],
  incoming: ConversationEvent,
): number {
  if (incoming.type !== 'user_message') return -1;
  const target = (incoming.text ?? '').trim();
  if (!target) return -1;
  // Walk backward — newest optimistic likely matches.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e.uuid.startsWith(OPTIMISTIC_PREFIX)) continue;
    if (e.type !== 'user_message') continue;
    if ((e.text ?? '').trim() === target) return i;
  }
  return -1;
}

export const useConversationStore = create<ConversationState>()((set) => ({
  eventsByTask: {},

  appendEvent: (taskId, event) =>
    set((state) => {
      const existing = state.eventsByTask[taskId] ?? [];
      // Dedup by uuid — backend dedupes on its side too, but WS reconnect
      // can replay the snapshot AND deliver in-flight events that overlap.
      if (existing.some((e) => e.uuid === event.uuid)) return state;

      // If this is a real user_message that matches an optimistic one we
      // emitted earlier, replace the placeholder in place.
      const optIdx = findMatchingOptimisticIndex(existing, event);
      if (optIdx >= 0) {
        const next = existing.slice();
        next[optIdx] = event;
        return {
          eventsByTask: {
            ...state.eventsByTask,
            [taskId]: next,
          },
        };
      }

      return {
        eventsByTask: {
          ...state.eventsByTask,
          [taskId]: [...existing, event],
        },
      };
    }),

  setEventsForTask: (taskId, events) =>
    set((state) => {
      // Preserve any optimistic placeholders that haven't been confirmed
      // yet — a snapshot from the server won't include them, but we don't
      // want them disappearing when the user reconnects mid-turn.
      const existing = state.eventsByTask[taskId] ?? [];
      const pendingOptimistic = existing.filter(
        (e) =>
          e.uuid.startsWith(OPTIMISTIC_PREFIX) &&
          // Drop stale optimistic entries that the snapshot already covers.
          !events.some(
            (snap) =>
              snap.type === 'user_message' &&
              (snap.text ?? '').trim() === (e.text ?? '').trim(),
          ),
      );
      return {
        eventsByTask: {
          ...state.eventsByTask,
          [taskId]: [...events, ...pendingOptimistic],
        },
      };
    }),

  appendOptimisticUserMessage: (taskId, text) => {
    const uuid = `${OPTIMISTIC_PREFIX}${taskId}:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
    set((state) => {
      const existing = state.eventsByTask[taskId] ?? [];
      const event: ConversationEvent = {
        uuid,
        taskId,
        sessionId: '',
        type: 'user_message',
        timestamp: new Date().toISOString(),
        text,
      };
      return {
        eventsByTask: {
          ...state.eventsByTask,
          [taskId]: [...existing, event],
        },
      };
    });
    return uuid;
  },

  clearTask: (taskId) =>
    set((state) => {
      if (!(taskId in state.eventsByTask)) return state;
      const next = { ...state.eventsByTask };
      delete next[taskId];
      return { eventsByTask: next };
    }),
}));

/** Selector: the current event list for one task (stable empty fallback). */
const EMPTY: ConversationEvent[] = [];
export function useConversationEvents(taskId: string | null | undefined): ConversationEvent[] {
  return useConversationStore((s) =>
    taskId ? (s.eventsByTask[taskId] ?? EMPTY) : EMPTY,
  );
}
