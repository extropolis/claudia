import { useEffect, useRef } from 'react';
import { useTaskStore } from '../stores/taskStore';

/**
 * ThinkingSoundManager - Plays a notification sound at regular intervals when any task is busy (thinking).
 * This component should be rendered at the App root level.
 */
export function ThinkingSoundManager() {
    const {
        tasks,
        thinkingSoundEnabled,
        thinkingSoundInterval
    } = useTaskStore();

    const intervalRef = useRef<NodeJS.Timeout | null>(null);

    // Play the thinking sound using Web Audio API
    const playThinkingSound = () => {
        try {
            const audioContext = new (window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            // Use a pleasant, unobtrusive tone
            oscillator.frequency.value = 600;
            oscillator.type = 'sine';
            gainNode.gain.setValueAtTime(0.2, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);

            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.2);
        } catch (e) {
            console.warn('[ThinkingSoundManager] Could not play thinking sound:', e);
        }
    };

    // Check if any task is currently busy (thinking)
    const hasActiveThinkingTask = () => {
        return Array.from(tasks.values()).some(task => task.state === 'busy' || task.state === 'starting');
    };

    useEffect(() => {
        // Clear any existing interval
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
        }

        // Only set up interval if feature is enabled and there's an active thinking task
        if (thinkingSoundEnabled && hasActiveThinkingTask()) {
            // Play immediately
            playThinkingSound();

            // Set up interval for subsequent sounds
            intervalRef.current = setInterval(() => {
                // Check if there are still busy tasks before playing
                if (hasActiveThinkingTask()) {
                    playThinkingSound();
                } else {
                    // Stop the interval if no tasks are busy anymore
                    if (intervalRef.current) {
                        clearInterval(intervalRef.current);
                        intervalRef.current = null;
                    }
                }
            }, thinkingSoundInterval);
        }

        // Cleanup on unmount or when dependencies change
        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [thinkingSoundEnabled, thinkingSoundInterval, tasks]);

    // This is a logic-only component, no UI
    return null;
}
