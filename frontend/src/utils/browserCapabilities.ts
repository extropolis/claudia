/**
 * Browser capability detection and feature checks
 */

/**
 * Check if running in Electron environment
 */
export function isElectron(): boolean {
    return typeof window !== 'undefined' && window.electronAPI !== undefined;
}

/**
 * Check if File System Access API is available
 * @see https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API
 */
export function hasFileSystemAccess(): boolean {
    return (
        typeof window !== 'undefined' &&
        'showDirectoryPicker' in window &&
        typeof (window as any).showDirectoryPicker === 'function'
    );
}

/**
 * Get available directory selection method
 * Returns the best available method for selecting directories
 */
export function getDirectorySelectionMethod(): 'electron' | 'filesystem-api' | 'none' {
    if (isElectron()) {
        return 'electron';
    }
    if (hasFileSystemAccess()) {
        return 'filesystem-api';
    }
    return 'none';
}

/**
 * Check if browser supports clipboard API
 */
export function hasClipboardAPI(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        navigator.clipboard !== undefined &&
        typeof navigator.clipboard.writeText === 'function'
    );
}

/**
 * Get user-friendly error message for unsupported features
 */
export function getUnsupportedFeatureMessage(feature: string): string {
    const messages: Record<string, string> = {
        'directory-picker':
            'Directory selection is not available in your browser. ' +
            'Please use the Electron app or a modern browser with File System Access API support ' +
            '(Chrome 86+, Edge 86+).',
        'clipboard':
            'Clipboard access is not available. Please copy the text manually.',
    };
    return messages[feature] || `This feature (${feature}) is not supported in your current environment.`;
}

/**
 * Browser compatibility information
 */
export interface BrowserCapabilities {
    isElectron: boolean;
    hasFileSystemAccess: boolean;
    hasClipboardAPI: boolean;
    directorySelectionMethod: 'electron' | 'filesystem-api' | 'none';
}

/**
 * Get all browser capabilities at once
 */
export function getBrowserCapabilities(): BrowserCapabilities {
    return {
        isElectron: isElectron(),
        hasFileSystemAccess: hasFileSystemAccess(),
        hasClipboardAPI: hasClipboardAPI(),
        directorySelectionMethod: getDirectorySelectionMethod(),
    };
}

/**
 * Check if browser supports Notification API
 */
export function hasBrowserNotifications(): boolean {
    return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Get current notification permission status
 */
export function getNotificationPermission(): NotificationPermission | 'unsupported' {
    if (!hasBrowserNotifications()) return 'unsupported';
    return Notification.permission;
}

/**
 * Request permission to show browser notifications
 * @returns Promise that resolves to the permission status
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (!hasBrowserNotifications()) return 'unsupported';
    
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    
    try {
        const permission = await Notification.requestPermission();
        return permission;
    } catch (error) {
        console.error('Failed to request notification permission:', error);
        return 'denied';
    }
}

/**
 * Send a browser notification
 * @param title - Notification title
 * @param options - Optional notification options (body, icon, etc.)
 * @returns The Notification object if successful, null otherwise
 */
export function sendBrowserNotification(
    title: string,
    options?: NotificationOptions
): Notification | null {
    if (!hasBrowserNotifications()) {
        console.warn('Browser notifications not supported');
        return null;
    }
    
    if (Notification.permission !== 'granted') {
        console.warn('Notification permission not granted');
        return null;
    }
    
    try {
        const notification = new Notification(title, {
            ...options,
        });
        
        // Auto-close after 5 seconds
        setTimeout(() => notification.close(), 5000);

        // Focus window when notification is clicked
        notification.onclick = () => {
            window.focus();
            // Dispatch custom event so the app can handle task focusing
            if (options?.data?.taskId) {
                window.dispatchEvent(new CustomEvent('notification:taskClick', {
                    detail: { taskId: options.data.taskId }
                }));
            }
            notification.close();
        };
        
        return notification;
    } catch (error) {
        console.error('Failed to send notification:', error);
        return null;
    }
}

/**
 * Persistent AudioContext — reused across calls so iOS user-gesture unlock persists.
 * Creating a new AudioContext each time loses the "unlocked" state.
 */
let persistentAudioCtx: AudioContext | null = null;

/**
 * Cached chime WAV blob URL for HTML Audio fallback (iOS background)
 */
let chimeWavUrl: string | null = null;

/**
 * Whether completion sound is enabled (persisted in localStorage)
 */
let _soundEnabled: boolean | null = null;

const SOUND_ENABLED_KEY = 'claudia-completion-sound';

export function isSoundEnabled(): boolean {
    if (_soundEnabled === null) {
        try {
            const saved = localStorage.getItem(SOUND_ENABLED_KEY);
            _soundEnabled = saved !== 'false'; // default to true
        } catch {
            _soundEnabled = true;
        }
    }
    return _soundEnabled;
}

export function setSoundEnabled(enabled: boolean): void {
    _soundEnabled = enabled;
    try {
        localStorage.setItem(SOUND_ENABLED_KEY, String(enabled));
    } catch { /* ignore */ }
}

function getOrCreateAudioContext(): AudioContext | null {
    if (!persistentAudioCtx) {
        const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return null;
        persistentAudioCtx = new AudioCtx();
    }
    // Resume if suspended (iOS auto-suspends after background)
    if (persistentAudioCtx.state === 'suspended') {
        persistentAudioCtx.resume().catch(() => {});
    }
    return persistentAudioCtx;
}

/**
 * Unlock AudioContext on first user interaction.
 * Must be called early (e.g., on app mount) so the context is ready.
 */
export function setupAudioUnlock(): void {
    const handler = () => {
        const ctx = getOrCreateAudioContext();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
    };
    // Keep listeners permanently — iOS can re-suspend after backgrounding
    document.addEventListener('click', handler, { passive: true });
    document.addEventListener('touchstart', handler, { passive: true });
}

/**
 * Generate a WAV file with the notification chime for HTML Audio fallback.
 * Used when AudioContext is suspended (iOS background).
 */
function generateChimeWav(): string | null {
    if (chimeWavUrl) return chimeWavUrl;
    try {
        const sampleRate = 22050;
        const duration = 0.9;
        const numSamples = Math.floor(sampleRate * duration);
        const buffer = new Float32Array(numSamples);

        const tones = [
            { freq: 523, start: 0, end: 0.2, vol: 0.3, fadeEnd: 0.6 },
            { freq: 659, start: 0.15, end: 0.5, vol: 0.3, fadeEnd: 0.7 },
            { freq: 784, start: 0.3, end: 0.7, vol: 0.25, fadeEnd: 0.9 },
        ];

        for (let i = 0; i < numSamples; i++) {
            const t = i / sampleRate;
            let sample = 0;
            for (const tone of tones) {
                if (t >= tone.start && t <= tone.fadeEnd) {
                    let env = 1;
                    if (t > tone.end) {
                        env = Math.exp(-8 * (t - tone.end) / (tone.fadeEnd - tone.end));
                    }
                    sample += Math.sin(2 * Math.PI * tone.freq * t) * tone.vol * env;
                }
            }
            buffer[i] = Math.max(-1, Math.min(1, sample));
        }

        // Encode as 16-bit PCM WAV
        const wavLength = 44 + numSamples * 2;
        const wavBuf = new ArrayBuffer(wavLength);
        const view = new DataView(wavBuf);

        const writeStr = (offset: number, str: string) => {
            for (let k = 0; k < str.length; k++) view.setUint8(offset + k, str.charCodeAt(k));
        };

        writeStr(0, 'RIFF');
        view.setUint32(4, wavLength - 8, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeStr(36, 'data');
        view.setUint32(40, numSamples * 2, true);

        for (let s = 0; s < numSamples; s++) {
            const val = Math.max(-1, Math.min(1, buffer[s]));
            view.setInt16(44 + s * 2, val < 0 ? val * 0x8000 : val * 0x7FFF, true);
        }

        const blob = new Blob([wavBuf], { type: 'audio/wav' });
        chimeWavUrl = URL.createObjectURL(blob);
        console.log('[Sound] Generated notification chime WAV');
        return chimeWavUrl;
    } catch (err) {
        console.warn('[Sound] Failed to generate chime WAV:', err);
        return null;
    }
}

/**
 * Play chime via Web Audio API (low latency, works in foreground)
 */
function playViaWebAudio(ctx: AudioContext): void {
    const now = ctx.currentTime;

    // First tone: C5 (~523 Hz)
    const gain1 = ctx.createGain();
    gain1.connect(ctx.destination);
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(523, now);
    osc1.connect(gain1);
    osc1.start(now);
    osc1.stop(now + 0.2);

    // Second tone: E5 (~659 Hz)
    const gain2 = ctx.createGain();
    gain2.connect(ctx.destination);
    gain2.gain.setValueAtTime(0, now);
    gain2.gain.setValueAtTime(0.25, now + 0.12);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(659, now + 0.12);
    osc2.connect(gain2);
    osc2.start(now + 0.12);
    osc2.stop(now + 0.35);

    // Third tone: G5 (~784 Hz)
    const gain3 = ctx.createGain();
    gain3.connect(ctx.destination);
    gain3.gain.setValueAtTime(0, now);
    gain3.gain.setValueAtTime(0.2, now + 0.25);
    gain3.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    const osc3 = ctx.createOscillator();
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(784, now + 0.25);
    osc3.connect(gain3);
    osc3.start(now + 0.25);
    osc3.stop(now + 0.5);

    console.log('[Sound] Task completion sound played via Web Audio');
}

/**
 * Play chime via HTML Audio element (fallback for suspended AudioContext on iOS)
 */
function playViaHtmlAudio(): void {
    const url = generateChimeWav();
    if (!url) return;
    try {
        const audio = new Audio(url);
        audio.play().then(() => {
            console.log('[Sound] Task completion sound played via HTML Audio');
        }).catch((err) => {
            console.warn('[Sound] HTML Audio fallback failed:', err.message);
        });
    } catch (err) {
        console.warn('[Sound] HTML Audio fallback error:', err);
    }
}

/**
 * Play a task completion sound using Web Audio API with HTML Audio fallback.
 * Uses three ascending tones (C5→E5→G5) for a pleasant "done!" chime.
 * Handles iOS background suspension by falling back to HTML Audio element.
 */
export function playTaskCompletionSound(): void {
    if (!isSoundEnabled()) {
        console.log('[Sound] Completion sound disabled, skipping');
        return;
    }

    try {
        const ctx = getOrCreateAudioContext();

        // If AudioContext is running, use Web Audio (best quality, lowest latency)
        if (ctx && ctx.state === 'running') {
            playViaWebAudio(ctx);
            return;
        }

        // AudioContext is suspended (iOS background) — try resuming + HTML Audio fallback
        if (ctx && ctx.state === 'suspended') {
            console.log('[Sound] AudioContext suspended, trying HTML Audio fallback');
            ctx.resume().then(() => {
                console.log('[Sound] AudioContext resumed, state:', ctx.state);
            }).catch(() => {});
            // Use HTML Audio immediately (most reliable on mobile)
            playViaHtmlAudio();
            return;
        }

        // No AudioContext at all — use HTML Audio
        console.log('[Sound] No AudioContext, using HTML Audio fallback');
        playViaHtmlAudio();
    } catch (e) {
        console.warn('[Sound] Could not play task completion sound:', e);
    }
}

/**
 * Play a test sound (for the sound toggle UI)
 */
export function playTestSound(): void {
    const prev = _soundEnabled;
    _soundEnabled = true;
    playTaskCompletionSound();
    _soundEnabled = prev;
}

/**
 * Send a task completion notification if tab is not visible
 * @param taskPrompt - The task prompt/description to include in notification
 * @returns true if notification was sent, false otherwise
 */
export function sendTaskCompletionNotification(options: {
    taskName?: string;
    lastMessage?: string;
    taskId?: string;
}): boolean {
    const { taskName, lastMessage, taskId } = options;
    const title = taskName
        ? taskName.length > 60 ? taskName.substring(0, 60) + '...' : taskName
        : 'Task Complete';

    const body = lastMessage
        ? lastMessage.length > 200 ? lastMessage.substring(0, 200) + '...' : lastMessage
        : 'Task finished executing';

    const notification = sendBrowserNotification(title, {
        body,
        tag: `task-complete-${taskId || 'unknown'}`,
        data: { taskId },
    });

    return notification !== null;
}

/**
 * Send a notification when a task is waiting for user input
 * @param taskPrompt - The task prompt/description
 * @param inputType - The type of input being requested
 * @returns true if notification was sent, false otherwise
 */
export function sendTaskWaitingInputNotification(options: {
    taskName?: string;
    recentOutput?: string;
    inputType?: string;
    taskId?: string;
}): boolean {
    const { taskName, recentOutput, inputType, taskId } = options;
    const typeLabel = inputType === 'permission' ? 'Needs Permission'
        : inputType === 'question' ? 'Has a Question'
        : inputType === 'confirmation' ? 'Needs Confirmation'
        : 'Needs Input';

    const title = taskName
        ? `${taskName.length > 50 ? taskName.substring(0, 50) + '...' : taskName} — ${typeLabel}`
        : `Task ${typeLabel}`;

    const body = recentOutput
        ? recentOutput.length > 150 ? recentOutput.substring(recentOutput.length - 150) : recentOutput
        : '';

    const notification = sendBrowserNotification(title, {
        body,
        tag: `task-waiting-input-${taskId || 'unknown'}`,
        data: { taskId },
    });

    return notification !== null;
}
