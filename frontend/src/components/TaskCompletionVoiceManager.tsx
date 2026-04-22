import { useEffect, useRef } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { useElevenLabsTTS } from '../hooks/useElevenLabsTTS';
import { getApiBaseUrl } from '../config/api-config';

/**
 * TaskCompletionVoiceManager - A logic-only component that announces task summaries
 * when tasks complete (busy → idle transition) in hands-free mode.
 *
 * This component should be rendered at the App root level.
 */
export function TaskCompletionVoiceManager() {
    const {
        tasks,
        voiceSummaryOnCompletion,
        globalVoiceEnabled
    } = useTaskStore();

    const { speak, cancel } = useElevenLabsTTS();
    const taskStatesRef = useRef<Map<string, string>>(new Map());
    const announcedCompletionsRef = useRef<Set<string>>(new Set()); // Track announced completions to avoid duplicates

    useEffect(() => {
        // Monitor task state changes
        tasks.forEach((task) => {
            const previousState = taskStatesRef.current.get(task.id);
            const currentState = task.state;

            // Update tracked state
            taskStatesRef.current.set(task.id, currentState);

            // Detect busy → idle transition (task completion)
            if (
                voiceSummaryOnCompletion &&
                globalVoiceEnabled &&
                previousState === 'busy' &&
                currentState === 'idle' &&
                !announcedCompletionsRef.current.has(task.id + task.lastActivity?.getTime())
            ) {
                // Mark this completion as announced
                announcedCompletionsRef.current.add(task.id + task.lastActivity?.getTime());

                console.log('[TaskCompletionVoiceManager] Task completed:', task.id, task.displayName || task.prompt);

                // Fetch the task summary/last message from the conversation API
                const taskName = task.displayName || task.prompt || 'Task';
                fetch(`${getApiBaseUrl()}/api/tasks/${task.id}/conversation`)
                    .then(res => res.ok ? res.json() : null)
                    .then(data => {
                        const messages = data?.messages || [];
                        const lastAssistant = [...messages].reverse().find((m: { role: string }) => m.role === 'assistant');

                        if (lastAssistant?.content) {
                            // Extract just the text content (strip markdown, code blocks, etc. for cleaner speech)
                            let summary = lastAssistant.content;

                            // Remove code blocks
                            summary = summary.replace(/```[\s\S]*?```/g, 'code block');
                            // Remove inline code
                            summary = summary.replace(/`[^`]+`/g, 'code');
                            // Remove markdown links but keep text
                            summary = summary.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
                            // Remove bold/italic markers
                            summary = summary.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');
                            // Limit length to first ~200 characters for brevity
                            if (summary.length > 200) {
                                summary = summary.substring(0, 200) + '...';
                            }

                            // Cancel any currently speaking announcement
                            cancel();

                            // Announce the completion with summary
                            const announcement = `${taskName} completed. ${summary}`;
                            console.log('[TaskCompletionVoiceManager] Announcing:', announcement);
                            speak(announcement);
                        } else {
                            // Fallback: just announce the task name if no summary available
                            cancel();
                            const announcement = `${taskName} completed.`;
                            console.log('[TaskCompletionVoiceManager] Announcing (no summary):', announcement);
                            speak(announcement);
                        }
                    })
                    .catch((err) => {
                        console.error('[TaskCompletionVoiceManager] Failed to fetch conversation:', err);
                        // Fallback announcement
                        cancel();
                        speak(`${taskName} completed.`);
                    });
            }
        });

        // Clean up old tracked states for deleted tasks
        const currentTaskIds = new Set(Array.from(tasks.keys()));
        for (const [taskId] of taskStatesRef.current) {
            if (!currentTaskIds.has(taskId)) {
                taskStatesRef.current.delete(taskId);
            }
        }
    }, [tasks, voiceSummaryOnCompletion, globalVoiceEnabled, speak, cancel]);

    // This is a logic-only component, no UI
    return null;
}
