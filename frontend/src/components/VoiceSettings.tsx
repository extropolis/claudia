import { useState, useEffect } from 'react';
import { X, Volume2, Mic, Settings } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import { useSpeechSynthesis } from '../hooks/useSpeechSynthesis';

interface VoiceSettingsProps {
    onClose: () => void;
}

export function VoiceSettings({ onClose }: VoiceSettingsProps) {
    const {
        voiceEnabled,
        autoSpeakResponses,
        selectedVoiceName,
        voiceRate,
        voicePitch,
        voiceVolume,
        setVoiceEnabled,
        setAutoSpeakResponses,
        setVoiceSettings
    } = useTaskStore();

    const { voices, speak } = useSpeechSynthesis();

    const [localVoice, setLocalVoice] = useState(selectedVoiceName || '');
    const [localRate, setLocalRate] = useState(voiceRate);
    const [localPitch, setLocalPitch] = useState(voicePitch);
    const [localVolume, setLocalVolume] = useState(voiceVolume);

    useEffect(() => {
        // Set default voice if none selected
        if (!localVoice && voices.length > 0) {
            const defaultVoice = voices.find(v => v.default) || voices[0];
            setLocalVoice(defaultVoice.name);
        }
    }, [voices, localVoice]);

    const handleSave = () => {
        setVoiceSettings({
            voiceName: localVoice || null,
            rate: localRate,
            pitch: localPitch,
            volume: localVolume
        });
        onClose();
    };

    const handleTest = () => {
        const testText = "Hello! This is how I sound with the current voice settings.";
        speak(testText);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content voice-settings-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>
                        <Settings size={20} />
                        Voice Settings
                    </h2>
                    <button className="close-button" onClick={onClose}>
                        <X size={20} />
                    </button>
                </div>

                <div className="modal-body">
                    <div className="settings-section">
                        <label className="toggle-label">
                            <input
                                type="checkbox"
                                checked={voiceEnabled}
                                onChange={(e) => setVoiceEnabled(e.target.checked)}
                            />
                            <Mic size={16} />
                            <span>Enable Voice Input</span>
                        </label>
                        <p className="setting-description">
                            Show microphone button to dictate messages using speech recognition
                        </p>
                    </div>

                    <div className="settings-section">
                        <label className="toggle-label">
                            <input
                                type="checkbox"
                                checked={autoSpeakResponses}
                                onChange={(e) => setAutoSpeakResponses(e.target.checked)}
                            />
                            <Volume2 size={16} />
                            <span>Auto-speak Responses</span>
                        </label>
                        <p className="setting-description">
                            Automatically read aloud responses from the orchestrator and tasks
                        </p>
                    </div>

                    <div className="settings-divider"></div>

                    <div className="settings-section">
                        <label className="setting-label">
                            Voice
                        </label>
                        <select
                            value={localVoice}
                            onChange={(e) => setLocalVoice(e.target.value)}
                            className="voice-select"
                            disabled={voices.length === 0}
                        >
                            {voices.length === 0 ? (
                                <option>Loading voices...</option>
                            ) : (
                                voices.map((voice) => (
                                    <option key={voice.name} value={voice.name}>
                                        {voice.name} ({voice.lang})
                                    </option>
                                ))
                            )}
                        </select>
                    </div>

                    <div className="settings-section">
                        <label className="setting-label">
                            Speed: {localRate.toFixed(1)}x
                        </label>
                        <input
                            type="range"
                            min="0.5"
                            max="2"
                            step="0.1"
                            value={localRate}
                            onChange={(e) => setLocalRate(parseFloat(e.target.value))}
                            className="slider"
                        />
                        <div className="slider-labels">
                            <span>Slow</span>
                            <span>Normal</span>
                            <span>Fast</span>
                        </div>
                    </div>

                    <div className="settings-section">
                        <label className="setting-label">
                            Pitch: {localPitch.toFixed(1)}
                        </label>
                        <input
                            type="range"
                            min="0.5"
                            max="2"
                            step="0.1"
                            value={localPitch}
                            onChange={(e) => setLocalPitch(parseFloat(e.target.value))}
                            className="slider"
                        />
                        <div className="slider-labels">
                            <span>Low</span>
                            <span>Normal</span>
                            <span>High</span>
                        </div>
                    </div>

                    <div className="settings-section">
                        <label className="setting-label">
                            Volume: {Math.round(localVolume * 100)}%
                        </label>
                        <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.1"
                            value={localVolume}
                            onChange={(e) => setLocalVolume(parseFloat(e.target.value))}
                            className="slider"
                        />
                        <div className="slider-labels">
                            <span>Quiet</span>
                            <span>Loud</span>
                        </div>
                    </div>

                    <button onClick={handleTest} className="test-voice-button">
                        <Volume2 size={16} />
                        Test Voice
                    </button>
                </div>

                <div className="modal-footer">
                    <button onClick={onClose} className="cancel-button">
                        Cancel
                    </button>
                    <button onClick={handleSave} className="save-button">
                        Save Settings
                    </button>
                </div>
            </div>
        </div>
    );
}
