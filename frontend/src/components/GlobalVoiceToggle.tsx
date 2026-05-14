import { useMemo, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import { DeepgramApiKeyModal } from './DeepgramApiKeyModal';
import './GlobalVoiceToggle.css';

/**
 * GlobalVoiceToggle - Header button for enabling/disabling always-listening voice mode.
 * Shows:
 * - Gray mic when OFF
 * - Red pulsing mic when ON
 * - Tooltip showing which input is focused
 */
export function GlobalVoiceToggle() {
  const {
    globalVoiceEnabled,
    focusedInputId,
    deepgramApiKey,
    autoSendEnabled,
    autoSendDelayMs,
    setGlobalVoiceEnabled,
    clearVoiceTranscript,
  } = useTaskStore();

  const [showApiKeyModal, setShowApiKeyModal] = useState(false);

  // Check if microphone API is available
  const isMicAvailable = useMemo(() => {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }, []);

  // Check if Deepgram key is configured
  const hasApiKey = !!deepgramApiKey;

  // Determine the target description for the tooltip
  const targetDescription = useMemo(() => {
    if (!focusedInputId) return 'None';
    if (focusedInputId.startsWith('task-')) return 'Task Input';
    if (focusedInputId.startsWith('new-task-')) return 'New Task';
    if (focusedInputId.startsWith('chat-')) return 'Chat';
    return 'Input';
  }, [focusedInputId]);

  const handleToggle = () => {
    // If no API key, show the modal to set it up
    if (!hasApiKey) {
      setShowApiKeyModal(true);
      return;
    }

    if (globalVoiceEnabled) {
      // Turning off - clear any pending transcript
      clearVoiceTranscript();
    }
    setGlobalVoiceEnabled(!globalVoiceEnabled);
  };

  const handleModalClose = () => {
    setShowApiKeyModal(false);
    // After setting API key, enable voice mode if mic is available
    if (isMicAvailable && useTaskStore.getState().deepgramApiKey) {
      setGlobalVoiceEnabled(true);
    }
  };

  // If mic is not available, show disabled button
  if (!isMicAvailable) {
    return (
      <button
        className="global-voice-toggle unsupported"
        disabled
        title="Voice input not supported in this browser"
      >
        <MicOff size={18} />
        <span>Voice</span>
      </button>
    );
  }

  // If no API key, show button that opens modal when clicked
  if (!hasApiKey) {
    return (
      <>
        <button
          className="global-voice-toggle needs-setup"
          onClick={handleToggle}
          title="Click to set up Deepgram API key"
        >
          <MicOff size={18} />
          <span>Voice</span>
        </button>
        <DeepgramApiKeyModal isOpen={showApiKeyModal} onClose={handleModalClose} />
      </>
    );
  }

  return (
    <button
      className={`global-voice-toggle ${globalVoiceEnabled ? 'active' : ''} ${globalVoiceEnabled && autoSendEnabled ? 'hands-free' : ''}`}
      onClick={handleToggle}
      title={
        globalVoiceEnabled
          ? `Voice Mode ON - Speaking to: ${targetDescription}${autoSendEnabled ? ` | Hands-Free (${autoSendDelayMs / 1000}s)` : ''}`
          : 'Enable Voice Mode'
      }
    >
      {globalVoiceEnabled ? <Mic size={18} className="mic-active" /> : <Mic size={18} />}
      <span>Voice</span>
      {globalVoiceEnabled && (
        <span className="voice-target-indicator">
          {targetDescription}
          {autoSendEnabled && <span className="hands-free-badge">🤲</span>}
        </span>
      )}
    </button>
  );
}
