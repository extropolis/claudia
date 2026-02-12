import { useState, useEffect, useRef, useCallback } from 'react';
import { Volume2, Mic, Radio, Clock } from 'lucide-react';
import { useTaskStore } from '../stores/taskStore';
import { useSpeechSynthesis } from '../hooks/useSpeechSynthesis';

export function VoiceSettingsContent() {
    const {
        voiceEnabled,
        autoSpeakResponses,
        selectedVoiceName,
        voiceRate,
        voicePitch,
        voiceVolume,
        globalVoiceEnabled,
        autoSendEnabled,
        autoSendDelayMs,
        setVoiceEnabled,
        setAutoSpeakResponses,
        setVoiceSettings,
        setGlobalVoiceEnabled,
        setAutoSendSettings
    } = useTaskStore();

    const { voices, speak } = useSpeechSynthesis();

    const [localVoice, setLocalVoice] = useState(selectedVoiceName || '');
    const [localRate, setLocalRate] = useState(voiceRate);
    const [localPitch, setLocalPitch] = useState(voicePitch);
    const [localVolume, setLocalVolume] = useState(voiceVolume);
    const [localAutoSendDelay, setLocalAutoSendDelay] = useState(autoSendDelayMs / 1000);

    // Debounce timers
    const voiceTimerRef = useRef<NodeJS.Timeout | null>(null);
    const autoSendTimerRef = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        if (!localVoice && voices.length > 0) {
            const defaultVoice = voices.find(v => v.default) || voices[0];
            setLocalVoice(defaultVoice.name);
        }
    }, [voices, localVoice]);

    const saveVoiceSettings = useCallback((voice: string, rate: number, pitch: number, volume: number) => {
        setVoiceSettings({
            voiceName: voice || null,
            rate,
            pitch,
            volume
        });
    }, [setVoiceSettings]);

    const handleVoiceChange = (voice: string) => {
        setLocalVoice(voice);
        // Save immediately for dropdowns
        saveVoiceSettings(voice, localRate, localPitch, localVolume);
    };

    const handleRateChange = (rate: number) => {
        setLocalRate(rate);
        // Auto-save with debounce
        if (voiceTimerRef.current) {
            clearTimeout(voiceTimerRef.current);
        }
        voiceTimerRef.current = setTimeout(() => {
            saveVoiceSettings(localVoice, rate, localPitch, localVolume);
        }, 500);
    };

    const handlePitchChange = (pitch: number) => {
        setLocalPitch(pitch);
        // Auto-save with debounce
        if (voiceTimerRef.current) {
            clearTimeout(voiceTimerRef.current);
        }
        voiceTimerRef.current = setTimeout(() => {
            saveVoiceSettings(localVoice, localRate, pitch, localVolume);
        }, 500);
    };

    const handleVolumeChange = (volume: number) => {
        setLocalVolume(volume);
        // Auto-save with debounce
        if (voiceTimerRef.current) {
            clearTimeout(voiceTimerRef.current);
        }
        voiceTimerRef.current = setTimeout(() => {
            saveVoiceSettings(localVoice, localRate, localPitch, volume);
        }, 500);
    };

    const handleAutoSendDelayChange = (delay: number) => {
        setLocalAutoSendDelay(delay);
        // Auto-save with debounce
        if (autoSendTimerRef.current) {
            clearTimeout(autoSendTimerRef.current);
        }
        autoSendTimerRef.current = setTimeout(() => {
            setAutoSendSettings(autoSendEnabled, delay * 1000);
        }, 500);
    };

    const handleTest = () => {
        const testText = "Hello! This is how I sound with the current voice settings.";
        speak(testText);
    };

    // Check if Web Speech API is supported
    const isSpeechSupported = !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

    return (
        <div className="voice-settings-content">
            {/* Always-Listening Voice Mode Section */}
            <div className="settings-section">
                <h3 className="settings-section-title">
                    <Radio size={16} />
                    Always-Listening Mode
                </h3>
                <label className="toggle-label">
                    <input
                        type="checkbox"
                        checked={globalVoiceEnabled}
                        onChange={(e) => setGlobalVoiceEnabled(e.target.checked)}
                        disabled={!isSpeechSupported}
                    />
                    <span>Enable Always-Listening Mode</span>
                </label>
                <p className="setting-description">
                    {isSpeechSupported
                        ? 'When enabled, voice input is always active. Speech routes to whichever input is focused.'
                        : 'Voice input is not supported in this browser.'}
                </p>
            </div>

            <div className="settings-section">
                <label className="toggle-label">
                    <input
                        type="checkbox"
                        checked={autoSendEnabled}
                        onChange={(e) => setAutoSendSettings(e.target.checked, localAutoSendDelay * 1000)}
                        disabled={!isSpeechSupported}
                    />
                    <Clock size={16} />
                    <span>Auto-send on Silence</span>
                </label>
                <p className="setting-description">
                    Automatically send message after you stop speaking
                </p>
            </div>

            {autoSendEnabled && (
                <div className="settings-section">
                    <label className="setting-label">
                        Silence Threshold: {localAutoSendDelay.toFixed(1)}s
                    </label>
                    <input
                        type="range"
                        min="1"
                        max="5"
                        step="0.5"
                        value={localAutoSendDelay}
                        onChange={(e) => handleAutoSendDelayChange(parseFloat(e.target.value))}
                        className="slider"
                    />
                    <div className="slider-labels">
                        <span>1s</span>
                        <span>3s</span>
                        <span>5s</span>
                    </div>
                </div>
            )}

            <div className="settings-divider"></div>

            {/* Original Voice Input/Output Settings */}
            <div className="settings-section">
                <h3 className="settings-section-title">
                    <Mic size={16} />
                    Voice Input
                </h3>
                <label className="toggle-label">
                    <input
                        type="checkbox"
                        checked={voiceEnabled}
                        onChange={(e) => setVoiceEnabled(e.target.checked)}
                    />
                    <span>Show Microphone Buttons (Legacy)</span>
                </label>
                <p className="setting-description">
                    Show individual microphone buttons on input fields (not needed with always-listening mode)
                </p>
            </div>

            <div className="settings-divider"></div>

            <div className="settings-section">
                <h3 className="settings-section-title">
                    <Volume2 size={16} />
                    Voice Output
                </h3>
                <label className="toggle-label">
                    <input
                        type="checkbox"
                        checked={autoSpeakResponses}
                        onChange={(e) => setAutoSpeakResponses(e.target.checked)}
                    />
                    <span>Auto-speak Responses</span>
                </label>
                <p className="setting-description">
                    Automatically read aloud responses from the orchestrator and tasks
                </p>
            </div>

            <div className="settings-section">
                <label className="setting-label">
                    Voice
                </label>
                <select
                    value={localVoice}
                    onChange={(e) => handleVoiceChange(e.target.value)}
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
                    onChange={(e) => handleRateChange(parseFloat(e.target.value))}
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
                    onChange={(e) => handlePitchChange(parseFloat(e.target.value))}
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
                    onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
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
    );
}
