import { useState } from 'react';
import { X, Key, ExternalLink } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import './DeepgramApiKeyModal.css';

interface DeepgramApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DeepgramApiKeyModal({ isOpen, onClose }: DeepgramApiKeyModalProps) {
  const { deepgramApiKey, setDeepgramApiKey } = useTaskStore();
  const [localKey, setLocalKey] = useState(deepgramApiKey);

  if (!isOpen) return null;

  const handleSave = () => {
    setDeepgramApiKey(localKey.trim());
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content deepgram-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            <Key size={20} />
            Deepgram API Key Required
          </h2>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          <p className="deepgram-info">
            Voice input requires a Deepgram API key for speech recognition. Learn more at{' '}
            <a
              href="https://deepgram.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="deepgram-link"
            >
              deepgram.com
              <ExternalLink size={14} />
            </a>
          </p>

          <div className="deepgram-steps">
            <ol>
              <li>
                Visit{' '}
                <a
                  href="https://console.deepgram.com/signup"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="deepgram-link"
                >
                  console.deepgram.com/signup
                  <ExternalLink size={14} />
                </a>
              </li>
              <li>Create a free account (includes $200 in credits)</li>
              <li>Go to the API Keys section</li>
              <li>Create a new API key and paste it below</li>
            </ol>
          </div>

          <div className="deepgram-input-container">
            <label htmlFor="deepgram-key" className="deepgram-label">
              API Key
            </label>
            <input
              id="deepgram-key"
              type="password"
              value={localKey}
              onChange={(e) => setLocalKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Enter your Deepgram API key..."
              className="deepgram-input"
              autoFocus
            />
          </div>
        </div>

        <div className="modal-footer">
          <button className="modal-button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="modal-button primary" onClick={handleSave} disabled={!localKey.trim()}>
            Save & Enable Voice
          </button>
        </div>
      </div>
    </div>
  );
}
