import { useEffect, useState } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { useVoiceRecognition } from '../hooks/useVoiceRecognition';

interface VoiceInputProps {
    onTranscript: (text: string, isFinal: boolean) => void;
    disabled?: boolean;
    continuous?: boolean;
    className?: string;
}

export function VoiceInput({ onTranscript, disabled = false, continuous = false, className = '' }: VoiceInputProps) {
    const [error, setError] = useState<string | null>(null);

    const {
        isSupported,
        isListening,
        startListening,
        stopListening,
        resetTranscript
    } = useVoiceRecognition({
        continuous,
        interimResults: true,
        onResult: (transcript, isFinal) => {
            setError(null);
            onTranscript(transcript, isFinal);
        },
        onError: (errorMessage) => {
            setError(errorMessage);
            setTimeout(() => setError(null), 3000);
        }
    });

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
}
