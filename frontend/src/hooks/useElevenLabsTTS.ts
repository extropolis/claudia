import { useState, useCallback, useRef } from 'react';
import { getApiBaseUrl } from '../config/api-config';

/**
 * Hook for ElevenLabs text-to-speech
 */
export function useElevenLabsTTS() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setIsSpeaking(false);
    setIsLoading(false);
  }, []);

  const speak = useCallback(
    async (text: string, voice: string = 'charlotte') => {
      // Cancel any ongoing speech
      cancel();

      if (!text.trim()) {
        return;
      }

      setIsLoading(true);

      try {
        const controller = new AbortController();
        abortControllerRef.current = controller;

        const response = await fetch(`${getApiBaseUrl()}/api/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'TTS request failed' }));
          throw new Error(err.error || `TTS HTTP ${response.status}`);
        }

        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);

        setIsLoading(false);
        setIsSpeaking(true);

        const audio = new Audio(audioUrl);
        audioRef.current = audio;

        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          audioRef.current = null;
          setIsSpeaking(false);
        };

        audio.onerror = () => {
          URL.revokeObjectURL(audioUrl);
          audioRef.current = null;
          setIsSpeaking(false);
          console.error('[ElevenLabsTTS] Audio playback error');
        };

        await audio.play();
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          console.log('[ElevenLabsTTS] Speech cancelled');
        } else {
          console.error('[ElevenLabsTTS] Speech error:', err);
        }
        setIsLoading(false);
        setIsSpeaking(false);
      }
    },
    [cancel],
  );

  return {
    speak,
    cancel,
    isSpeaking,
    isLoading,
  };
}
