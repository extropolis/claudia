import { useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { useDeepgramRecognition } from '../hooks/useDeepgramRecognition';
import { useTaskStore } from '../stores/taskStore';

interface VoiceInputProps {
    onTranscript: (text: string, isFinal: boolean) => void;
    disabled?: boolean;
    continuous?: boolean;
    className?: string;
}

export interface VoiceInputHandle {
    stopListening: () => void;
}

export const VoiceInput = forwardRef<VoiceInputHandle, VoiceInputProps>(function VoiceInput(
    { onTranscript, disabled = false, continuous = false, className = '' },
    ref
) {
    const [error, setError] = useState<string | null>(null);
    const deepgramApiKey = useTaskStore(s => s.deepgramApiKey);

    const {
        isSupported,
        isListening,
        startListening,
        stopListening,
        resetTranscript
    } = useDeepgramRecognition({
        continuous,
        interimResults: true,
        deepgramApiKey,
        onResult: (transcript, isFinal) => {
            setError(null);
            onTranscript(transcript, isFinal);
        },
        onError: (errorMessage) => {
            setError(errorMessage);
            setTimeout(() => setError(null), 3000);
        }
    });

    useImperativeHandle(ref, () => ({
        stopListening
    }), [stopListening]);

    useEffect(() => {
        // Clean up on unmount
        return () => {
            if (isListening) {
                stopListening();
            }
        };
    }, [isListening, stopListening]);

    const handleClick = () => {
        if (isListening) {
            stopListening();
        } else {
            resetTranscript();
            setError(null);
            startListening();
        }
    };

    if (!isSupported) {
        return (
            <button
                type="button"
                className={`voice-input-button unsupported ${className}`}
                disabled={true}
                title="Voice input not supported in this browser"
            >
                <MicOff size={20} />
            </button>
        );
    }

    return (
        <div className="voice-input-container">
            <button
                type="button"
                className={`voice-input-button ${isListening ? 'listening' : ''} ${className}`}
                onClick={handleClick}
                disabled={disabled}
                title={isListening ? 'Stop listening' : 'Start voice input'}
            >
                {isListening ? (
                    <Loader2 size={20} className="listening-spinner" />
                ) : (
                    <Mic size={20} />
                )}
            </button>
            {error && (
                <div className="voice-error-tooltip">{error}</div>
            )}
        </div>
    );
});
