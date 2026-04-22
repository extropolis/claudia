import { useState, useEffect, useRef, useCallback } from 'react';
import { Volume2, Mic, Radio, Clock, Key, Bell, CheckCircle } from 'lucide-react';
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
        deepgramApiKey,
        thinkingSoundEnabled,
        thinkingSoundInterval,
        voiceSummaryOnCompletion,
        voiceProgressUpdatesEnabled,
        voiceProgressUpdateInterval,
        setVoiceEnabled,
        setAutoSpeakResponses,
        setVoiceSettings,
        setGlobalVoiceEnabled,
        setAutoSendSettings,
        setDeepgramApiKey,
        setThinkingSoundEnabled,
        setThinkingSoundInterval,
        setVoiceSummaryOnCompletion,
        setVoiceProgressUpdatesEnabled,
        setVoiceProgressUpdateInterval
    } = useTaskStore();

    const { voices, speak } = useSpeechSynthesis();

    const [localVoice, setLocalVoice] = useState(selectedVoiceName || '');
    const [localRate, setLocalRate] = useState(voiceRate);
    const [localPitch, setLocalPitch] = useState(voicePitch);
    const [localVolume, setLocalVolume] = useState(voiceVolume);
    const [localAutoSendDelay, setLocalAutoSendDelay] = useState(autoSendDelayMs / 1000);
    const [localThinkingSoundInterval, setLocalThinkingSoundInterval] = useState(thinkingSoundInterval / 1000);
    const [localProgressUpdateInterval, setLocalProgressUpdateInterval] = useState(voiceProgressUpdateInterval / 1000);

    // Debounce timers
    const voiceTimerRef = useRef<NodeJS.Timeout | null>(null);
    const autoSendTimerRef = useRef<NodeJS.Timeout | null>(null);
    const thinkingSoundTimerRef = useRef<NodeJS.Timeout | null>(null);
    const progressUpdateTimerRef = useRef<NodeJS.Timeout | null>(null);

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

    const handleThinkingSoundIntervalChange = (interval: number) => {
        setLocalThinkingSoundInterval(interval);
        // Auto-save with debounce
        if (thinkingSoundTimerRef.current) {
            clearTimeout(thinkingSoundTimerRef.current);
        }
        thinkingSoundTimerRef.current = setTimeout(() => {
            setThinkingSoundInterval(interval * 1000);
        }, 500);
    };

    const handleProgressUpdateIntervalChange = (interval: number) => {
        setLocalProgressUpdateInterval(interval);
        // Auto-save with debounce
        if (progressUpdateTimerRef.current) {
            clearTimeout(progressUpdateTimerRef.current);
        }
        progressUpdateTimerRef.current = setTimeout(() => {
            setVoiceProgressUpdateInterval(interval * 1000);
        }, 500);
    };

    const handleTest = () => {
        const testText = "Hello! This is how I sound with the current voice settings.";
        speak(testText);
    };

    // Check if microphone API is available (works on all modern browsers)
    const isMicSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const hasApiKey = !!deepgramApiKey;

    return (
        <div className="voice-settings-content">
            {/* Deepgram API Key Section */}
            <div className="settings-section">
                <h3 className="settings-section-title">
                    <Key size={16} />
                    Deepgram API Key
                </h3>
                <input
                    type="password"
                    value={deepgramApiKey}
                    onChange={(e) => setDeepgramApiKey(e.target.value)}
                    placeholder="Enter Deepgram API key..."
                    className="voice-select"
                    style={{ width: '100%', maxWidth: '100%', fontFamily: 'monospace', fontSize: '13px' }}
                />
                <p className="setting-description">
                    {hasApiKey
                        ? 'Deepgram Nova-3 will be used for voice recognition (faster & more accurate).'
                        : 'Enter a Deepgram API key to enable voice recognition.'}
                </p>
            </div>

            <div className="settings-divider"></div>

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
                        disabled={!isMicSupported || !hasApiKey}
                    />
                    <span>Enable Always-Listening Mode</span>
                </label>
                <p className="setting-description">
                    {!isMicSupported
                        ? 'Microphone not available in this browser.'
                        : !hasApiKey
                        ? 'Set a Deepgram API key above to enable voice input.'
                        : 'When enabled, voice input is always active. Speech routes to whichever input is focused.'}
                </p>
            </div>

            <div className="settings-section">
                <h3 className="settings-section-title">
                    <Clock size={16} />
                    Hands-Free Mode
                </h3>
                <label className="toggle-label">
                    <input
                        type="checkbox"
                        checked={autoSendEnabled}
                        onChange={(e) => setAutoSendSettings(e.target.checked, localAutoSendDelay * 1000)}
                        disabled={!isMicSupported || !hasApiKey || !globalVoiceEnabled}
                    />
                    <span>Enable Hands-Free Mode</span>
                </label>
                <p className="setting-description">
                    {!globalVoiceEnabled
                        ? 'Enable Always-Listening Mode above to use hands-free mode.'
                        : 'Automatically send your message after you stop speaking. Perfect for truly hands-free interaction.'}
                </p>
            </div>

            {autoSendEnabled && (
                <div className="settings-section">
                    <label className="setting-label">
                        Auto-Send Delay: {localAutoSendDelay.toFixed(1)}s
                    </label>
                    <input
                        type="range"
                        min="0.5"
                        max="5"
                        step="0.5"
                        value={localAutoSendDelay}
                        onChange={(e) => handleAutoSendDelayChange(parseFloat(e.target.value))}
                        className="slider"
                    />
                    <div className="slider-labels">
                        <span>Fast (0.5s)</span>
                        <span>Normal (2.5s)</span>
                        <span>Slow (5s)</span>
                    </div>
                    <p className="setting-description" style={{ marginTop: '8px', fontSize: '12px' }}>
                        Message will be sent automatically after {localAutoSendDelay.toFixed(1)} seconds of silence
                    </p>
                </div>
            )}

            <div className="settings-divider"></div>

            {/* Voice Summary on Completion Section */}
            <div className="settings-section">
                <h3 className="settings-section-title">
                    <CheckCircle size={16} />
                    Hands-Free Completion Summaries
                </h3>
                <label className="toggle-label">
                    <input
                        type="checkbox"
                        checked={voiceSummaryOnCompletion}
                        onChange={(e) => setVoiceSummaryOnCompletion(e.target.checked)}
                        disabled={!globalVoiceEnabled}
                    />
                    <span>Announce Task Summaries When Complete</span>
                </label>
                <p className="setting-description">
                    {!globalVoiceEnabled
                        ? 'Enable Always-Listening Mode above to use this feature.'
                        : 'Automatically speaks the task summary when a task completes. Perfect for hands-free workflow - you can use your voice to give the next instruction immediately.'}
                </p>
            </div>

            <div className="settings-divider"></div>

            {/* Voice Progress Updates Section */}
            <div className="settings-section">
                <h3 className="settings-section-title">
                    <Clock size={16} />
                    Hands-Free Progress Updates
                </h3>
                <label className="toggle-label">
                    <input
                        type="checkbox"
                        checked={voiceProgressUpdatesEnabled}
                        onChange={(e) => setVoiceProgressUpdatesEnabled(e.target.checked)}
                        disabled={!globalVoiceEnabled}
                    />
                    <span>Announce Progress for Long-Running Tasks</span>
                </label>
                <p className="setting-description">
                    {!globalVoiceEnabled
                        ? 'Enable Always-Listening Mode above to use this feature.'
                        : 'Periodically announces what active tasks are working on. Helpful for staying informed without looking at the screen.'}
                </p>
            </div>

            {voiceProgressUpdatesEnabled && (
                <div className="settings-section">
                    <label className="setting-label">
                        Update Interval: {Math.floor(localProgressUpdateInterval / 60)}m {Math.floor(localProgressUpdateInterval % 60)}s
                    </label>
                    <input
                        type="range"
                        min="60"
                        max="600"
                        step="60"
                        value={localProgressUpdateInterval}
                        onChange={(e) => handleProgressUpdateIntervalChange(parseFloat(e.target.value))}
                        className="slider"
                    />
                    <div className="slider-labels">
                        <span>Frequent (1m)</span>
                        <span>Default (3m)</span>
                        <span>Rare (10m)</span>
                    </div>
                    <p className="setting-description" style={{ marginTop: '8px', fontSize: '12px' }}>
                        Progress will be announced every {Math.floor(localProgressUpdateInterval / 60)} minutes {Math.floor(localProgressUpdateInterval % 60) > 0 ? `and ${Math.floor(localProgressUpdateInterval % 60)} seconds` : ''} for busy tasks
                    </p>
                </div>
            )}

            <div className="settings-divider"></div>

            {/* Thinking Sound Section */}
            <div className="settings-section">
                <h3 className="settings-section-title">
                    <Bell size={16} />
                    Thinking Sound
                </h3>
                <label className="toggle-label">
                    <input
                        type="checkbox"
                        checked={thinkingSoundEnabled}
                        onChange={(e) => setThinkingSoundEnabled(e.target.checked)}
                    />
                    <span>Play Sound When Claude is Thinking</span>
                </label>
                <p className="setting-description">
                    Play a gentle notification sound at regular intervals while any task is actively thinking or processing
                </p>
            </div>

            {thinkingSoundEnabled && (
                <div className="settings-section">
                    <label className="setting-label">
                        Sound Interval: {localThinkingSoundInterval.toFixed(1)}s
                    </label>
                    <input
                        type="range"
                        min="1"
                        max="30"
                        step="1"
                        value={localThinkingSoundInterval}
                        onChange={(e) => handleThinkingSoundIntervalChange(parseFloat(e.target.value))}
                        className="slider"
                    />
                    <div className="slider-labels">
                        <span>Frequent (1s)</span>
                        <span>Normal (15s)</span>
                        <span>Rare (30s)</span>
                    </div>
                    <p className="setting-description" style={{ marginTop: '8px', fontSize: '12px' }}>
                        Sound will play every {localThinkingSoundInterval.toFixed(1)} seconds while Claude is thinking
                    </p>
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
