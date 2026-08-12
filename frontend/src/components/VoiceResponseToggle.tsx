import { Volume2, VolumeX } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import './VoiceResponseToggle.css';

/**
 * VoiceResponseToggle - Header button for enabling/disabling spoken task
 * completion summaries (voice responses). Sits next to GlobalVoiceToggle.
 */
export function VoiceResponseToggle() {
    const { voiceSummaryOnCompletion, setVoiceSummaryOnCompletion } = useTaskStore();

    const handleToggle = () => {
        setVoiceSummaryOnCompletion(!voiceSummaryOnCompletion);
    };

    return (
        <button
            className={`voice-response-toggle ${voiceSummaryOnCompletion ? 'active' : ''}`}
            onClick={handleToggle}
            title={voiceSummaryOnCompletion ? 'Voice Responses ON - Task summaries will be spoken aloud' : 'Enable Voice Responses'}
            aria-pressed={voiceSummaryOnCompletion}
        >
            {voiceSummaryOnCompletion ? <Volume2 size={18} /> : <VolumeX size={18} />}
            <span>Speak</span>
        </button>
    );
}
