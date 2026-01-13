import { useState, useEffect, useRef, useCallback } from 'react';

interface SpeechSynthesisOptions {
    voice?: SpeechSynthesisVoice | null;
    rate?: number;
    pitch?: number;
    volume?: number;
    onEnd?: () => void;
    onError?: (error: string) => void;
}

export function useSpeechSynthesis(options: SpeechSynthesisOptions = {}) {
    const {
        voice = null,
        rate = 1,
        pitch = 1,
        volume = 1,
        onEnd,
        onError
    } = options;

    const [isSupported, setIsSupported] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(voice);

    const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

    // Check for browser support and load voices
    useEffect(() => {
        if ('speechSynthesis' in window) {
            setIsSupported(true);

            const loadVoices = () => {
                const availableVoices = window.speechSynthesis.getVoices();
                setVoices(availableVoices);

                // Try to select a good default voice
                if (!selectedVoice && availableVoices.length > 0) {
                    // Prefer English voices
                    const englishVoice = availableVoices.find(v => v.lang.startsWith('en'));
                    setSelectedVoice(englishVoice || availableVoices[0]);
                }
            };

            // Load voices immediately
            loadVoices();

            // Some browsers need this event
            window.speechSynthesis.onvoiceschanged = loadVoices;

            // Update speaking state
            const checkSpeaking = setInterval(() => {
                setIsSpeaking(window.speechSynthesis.speaking);
                setIsPaused(window.speechSynthesis.paused);
            }, 100);

            return () => {
                clearInterval(checkSpeaking);
                window.speechSynthesis.cancel();
            };
        } else {
            setIsSupported(false);
        }
    }, [selectedVoice]);

    const speak = useCallback((text: string) => {
        if (!isSupported || !text) return;

        // Cancel any ongoing speech
        window.speechSynthesis.cancel();

        // Create new utterance
        const utterance = new SpeechSynthesisUtterance(text);
        utteranceRef.current = utterance;

        // Configure utterance
        if (selectedVoice) {
            utterance.voice = selectedVoice;
        }
        utterance.rate = rate;
        utterance.pitch = pitch;
        utterance.volume = volume;

        // Set up event handlers
        utterance.onstart = () => {
            setIsSpeaking(true);
            setIsPaused(false);
        };

        utterance.onend = () => {
            setIsSpeaking(false);
            setIsPaused(false);
            onEnd?.();
        };

        utterance.onerror = (event) => {
            console.error('Speech synthesis error:', event);
            setIsSpeaking(false);
            setIsPaused(false);
            onError?.(event.error);
        };

        // Start speaking
        try {
            window.speechSynthesis.speak(utterance);
        } catch (error) {
            console.error('Failed to speak:', error);
            onError?.('Failed to start speech synthesis');
        }
    }, [isSupported, selectedVoice, rate, pitch, volume, onEnd, onError]);

    const pause = useCallback(() => {
        if (isSupported && isSpeaking && !isPaused) {
            window.speechSynthesis.pause();
            setIsPaused(true);
        }
    }, [isSupported, isSpeaking, isPaused]);

    const resume = useCallback(() => {
        if (isSupported && isPaused) {
            window.speechSynthesis.resume();
            setIsPaused(false);
        }
    }, [isSupported, isPaused]);

    const cancel = useCallback(() => {
        if (isSupported) {
            window.speechSynthesis.cancel();
            setIsSpeaking(false);
            setIsPaused(false);
        }
    }, [isSupported]);

    return {
        isSupported,
        isSpeaking,
        isPaused,
        voices,
        selectedVoice,
        setSelectedVoice,
        speak,
        pause,
        resume,
        cancel
    };
}
