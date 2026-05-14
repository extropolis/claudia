import { useEffect, useRef } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { useElevenLabsTTS } from '../hooks/useElevenLabsTTS';
import { getApiBaseUrl } from '../config/api-config';

/**
 * TaskProgressVoiceManager - A logic-only component that announces periodic progress
 * updates for long-running tasks in hands-free mode.
 *
 * This component should be rendered at the App root level.
 */
export function TaskProgressVoiceManager() {
  const { tasks, voiceProgressUpdatesEnabled, voiceProgressUpdateInterval, globalVoiceEnabled } =
    useTaskStore();

  const { speak, cancel } = useElevenLabsTTS();
  const progressTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const lastAnnouncedRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!voiceProgressUpdatesEnabled || !globalVoiceEnabled) {
      // Clear all timers if feature is disabled
      progressTimersRef.current.forEach((timer) => clearInterval(timer));
      progressTimersRef.current.clear();
      lastAnnouncedRef.current.clear();
      return;
    }

    // Monitor busy tasks and set up interval timers for progress updates
    tasks.forEach((task) => {
      if (task.state === 'busy') {
        // Check if we already have a timer for this task
        if (!progressTimersRef.current.has(task.id)) {
          console.log('[TaskProgressVoiceManager] Starting progress tracker for task:', task.id);

          // Set up interval to announce progress
          const timer = setInterval(() => {
            const currentTask = useTaskStore.getState().tasks.get(task.id);
            if (!currentTask || currentTask.state !== 'busy') {
              // Task is no longer busy, clear timer
              console.log(
                '[TaskProgressVoiceManager] Task no longer busy, stopping tracker:',
                task.id,
              );
              const timerId = progressTimersRef.current.get(task.id);
              if (timerId) {
                clearInterval(timerId);
                progressTimersRef.current.delete(task.id);
              }
              return;
            }

            // Check if enough time has passed since last announcement
            const lastAnnounced = lastAnnouncedRef.current.get(task.id) || 0;
            const now = Date.now();
            if (now - lastAnnounced < voiceProgressUpdateInterval) {
              return; // Too soon, skip
            }

            lastAnnouncedRef.current.set(task.id, now);

            console.log('[TaskProgressVoiceManager] Announcing progress for task:', task.id);

            // Fetch recent output/activity to generate progress update
            const taskName = currentTask.displayName || currentTask.prompt || 'Task';
            fetch(`${getApiBaseUrl()}/api/tasks/${task.id}/conversation`)
              .then((res) => (res.ok ? res.json() : null))
              .then((data) => {
                const messages = data?.messages || [];
                // Find the most recent assistant message
                const lastAssistant = [...messages]
                  .reverse()
                  .find((m: { role: string }) => m.role === 'assistant');

                let progressSummary = 'is still working';

                if (lastAssistant?.content) {
                  // Extract a brief snippet of what Claude is doing
                  let snippet = lastAssistant.content;

                  // Remove code blocks
                  snippet = snippet.replace(/```[\s\S]*?```/g, '');
                  // Remove inline code
                  snippet = snippet.replace(/`[^`]+`/g, '');
                  // Remove markdown
                  snippet = snippet.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
                  snippet = snippet.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');

                  // Get first sentence or first ~80 chars
                  const firstSentence =
                    snippet.match(/^[^.!?]+[.!?]/)?.[0] || snippet.substring(0, 80);
                  if (firstSentence.trim()) {
                    progressSummary = `is ${firstSentence.trim().toLowerCase()}`;
                  }
                }

                // Cancel any currently speaking announcement to avoid overlap
                cancel();

                const announcement = `${taskName} ${progressSummary}`;
                console.log('[TaskProgressVoiceManager] Announcing:', announcement);
                speak(announcement);
              })
              .catch((err) => {
                console.error('[TaskProgressVoiceManager] Failed to fetch progress:', err);
                // Fallback announcement
                cancel();
                speak(`${taskName} is still working.`);
              });
          }, voiceProgressUpdateInterval);

          progressTimersRef.current.set(task.id, timer);
        }
      } else {
        // Task is not busy, clear any existing timer
        const timer = progressTimersRef.current.get(task.id);
        if (timer) {
          console.log('[TaskProgressVoiceManager] Task no longer busy, clearing timer:', task.id);
          clearInterval(timer);
          progressTimersRef.current.delete(task.id);
          lastAnnouncedRef.current.delete(task.id);
        }
      }
    });

    // Clean up timers for deleted tasks
    const currentTaskIds = new Set(Array.from(tasks.keys()));
    for (const [taskId, timer] of progressTimersRef.current) {
      if (!currentTaskIds.has(taskId)) {
        console.log('[TaskProgressVoiceManager] Task deleted, clearing timer:', taskId);
        clearInterval(timer);
        progressTimersRef.current.delete(taskId);
        lastAnnouncedRef.current.delete(taskId);
      }
    }
  }, [
    tasks,
    voiceProgressUpdatesEnabled,
    voiceProgressUpdateInterval,
    globalVoiceEnabled,
    speak,
    cancel,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      progressTimersRef.current.forEach((timer) => clearInterval(timer));
      progressTimersRef.current.clear();
      lastAnnouncedRef.current.clear();
    };
  }, []);

  // This is a logic-only component, no UI
  return null;
}
