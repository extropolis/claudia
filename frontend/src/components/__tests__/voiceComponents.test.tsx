/**
 * Voice components — the UI and logic-only wrappers around Claudia's voice mode.
 *
 * The recognition/synthesis hooks themselves are covered in
 * hooks/__tests__/voiceHooks.test.tsx. Here they are MOCKED so each test
 * exercises component behaviour: what renders in idle/listening/error states,
 * what lands in the task store, and what the logic-only managers actually do.
 *
 * NOTE ON COMPONENT NAMES: the brief named `HeadphoneVoiceToggle`,
 * `HeadphoneDeviceManager` and `VoiceWorkspaceManager`. No such files exist.
 * By line count and role they map to `GlobalVoiceToggle` (122),
 * `GlobalVoiceManager` (122) and — since the only 396-line file in the tree is
 * the non-voice `WorkspaceManager.tsx` — the real voice manager
 * `TaskCompletionVoiceManager` is covered in its place.
 *
 * Teardown order matters: RTL's auto-cleanup afterEach runs AFTER ours, so a
 * component unmounting late would call into globals we already restored.
 * Every afterEach here calls cleanup() FIRST.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Task } from '@claudia/shared';

vi.mock('../../config/api-config', () => ({
    getApiBaseUrl: () => 'http://claudia.test:9999',
    getWebSocketUrl: () => 'ws://claudia.test:9999',
    isTunnelAccess: () => false,
    getMobileToken: () => null,
    isElectron: () => false,
}));

// --- hook mocks ------------------------------------------------------------
// Each mock exposes a mutable `state` the test drives, plus spies for the
// controls the components call.

const deepgram = vi.hoisted(() => ({
    state: {
        isSupported: true,
        isListening: false,
        transcript: '',
        interimTranscript: '',
    },
    startListening: vi.fn(),
    stopListening: vi.fn(),
    resetTranscript: vi.fn(),
    /** Latest options object the component passed in — how we fire callbacks. */
    lastOptions: null as any,
    reset() {
        deepgram.state = {
            isSupported: true,
            isListening: false,
            transcript: '',
            interimTranscript: '',
        };
        deepgram.startListening = vi.fn();
        deepgram.stopListening = vi.fn();
        deepgram.resetTranscript = vi.fn();
        deepgram.lastOptions = null;
    },
}));

vi.mock('../../hooks/useDeepgramRecognition', () => ({
    useDeepgramRecognition: (options: any = {}) => {
        deepgram.lastOptions = options;
        return {
            ...deepgram.state,
            startListening: deepgram.startListening,
            stopListening: deepgram.stopListening,
            resetTranscript: deepgram.resetTranscript,
        };
    },
}));

const synthesis = vi.hoisted(() => ({
    voices: [] as any[],
    speak: vi.fn(),
    reset() {
        synthesis.voices = [];
        synthesis.speak = vi.fn();
    },
}));

vi.mock('../../hooks/useSpeechSynthesis', () => ({
    useSpeechSynthesis: () => ({
        isSupported: true,
        isSpeaking: false,
        isPaused: false,
        voices: synthesis.voices,
        selectedVoice: synthesis.voices[0] ?? null,
        setSelectedVoice: vi.fn(),
        speak: synthesis.speak,
        pause: vi.fn(),
        resume: vi.fn(),
        cancel: vi.fn(),
    }),
}));

const elevenLabs = vi.hoisted(() => ({
    speak: vi.fn(),
    cancel: vi.fn(),
    reset() {
        elevenLabs.speak = vi.fn();
        elevenLabs.cancel = vi.fn();
    },
}));

vi.mock('../../hooks/useElevenLabsTTS', () => ({
    useElevenLabsTTS: () => ({
        speak: elevenLabs.speak,
        cancel: elevenLabs.cancel,
        isSpeaking: false,
        isLoading: false,
    }),
}));

import { VoiceInput } from '../VoiceInput';
import type { VoiceInputHandle } from '../VoiceInput';
import { GlobalVoiceToggle } from '../GlobalVoiceToggle';
import { GlobalVoiceManager } from '../GlobalVoiceManager';
import { VoiceSettingsContent } from '../VoiceSettingsContent';
import { DeepgramApiKeyModal } from '../DeepgramApiKeyModal';
import { TaskCompletionVoiceManager } from '../TaskCompletionVoiceManager';
import { useTaskStore } from '../../stores/taskStore';

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------

const pristine = { ...useTaskStore.getState() };

function resetStore(overrides: Record<string, unknown> = {}) {
    useTaskStore.setState(
        {
            ...pristine,
            tasks: new Map(),
            voiceEnabled: false,
            autoSpeakResponses: false,
            selectedVoiceName: null,
            voiceRate: 1.0,
            voicePitch: 1.0,
            voiceVolume: 1.0,
            globalVoiceEnabled: false,
            focusedInputId: null,
            voiceTranscript: '',
            voiceInterimTranscript: '',
            autoSendEnabled: false,
            autoSendDelayMs: 3000,
            deepgramApiKey: '',
            thinkingSoundEnabled: false,
            thinkingSoundInterval: 5000,
            voiceSummaryOnCompletion: false,
            voiceProgressUpdatesEnabled: false,
            voiceProgressUpdateInterval: 180000,
            ...overrides,
        },
        true
    );
}

/** A microphone-capable navigator, which jsdom does not provide. */
function installMic(available = true) {
    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: available ? { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) } : undefined,
    });
}

function makeTask(overrides: Partial<Task> = {}): Task {
    return {
        id: 'task-1',
        prompt: 'do the thing',
        state: 'idle',
        workspaceId: '/repo',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        lastActivity: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    } as Task;
}

beforeEach(() => {
    localStorage.clear();
    resetStore();
    deepgram.reset();
    synthesis.reset();
    elevenLabs.reset();
    installMic(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // setDeepgramApiKey fires a background sync PUT; keep it off the network.
    global.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
    })) as any;
});

afterEach(() => {
    cleanup();
    // @ts-expect-error – removing the property we installed
    delete navigator.mediaDevices;
    vi.restoreAllMocks();
});

// ===========================================================================
// VoiceInput
// ===========================================================================

describe('VoiceInput', () => {
    it('renders a disabled control when recognition is unsupported', () => {
        deepgram.state.isSupported = false;

        render(<VoiceInput onTranscript={vi.fn()} />);

        const button = screen.getByRole('button', {
            name: /voice input not supported/i,
        });
        expect(button).toBeDisabled();
    });

    it('offers to start voice input when idle', () => {
        render(<VoiceInput onTranscript={vi.fn()} />);

        expect(screen.getByRole('button', { name: /start voice input/i })).toBeEnabled();
    });

    it('starts listening on click, clearing any previous transcript first', async () => {
        const user = userEvent.setup();
        render(<VoiceInput onTranscript={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: /start voice input/i }));

        expect(deepgram.resetTranscript).toHaveBeenCalledTimes(1);
        expect(deepgram.startListening).toHaveBeenCalledTimes(1);
    });

    it('offers to stop, and stops, while listening', async () => {
        const user = userEvent.setup();
        deepgram.state.isListening = true;
        render(<VoiceInput onTranscript={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: /stop listening/i }));

        expect(deepgram.stopListening).toHaveBeenCalledTimes(1);
        expect(deepgram.startListening).not.toHaveBeenCalled();
    });

    it('honours the disabled prop', () => {
        render(<VoiceInput onTranscript={vi.fn()} disabled />);

        expect(screen.getByRole('button', { name: /start voice input/i })).toBeDisabled();
    });

    it('forwards transcripts to the caller with their final flag', () => {
        const onTranscript = vi.fn();
        render(<VoiceInput onTranscript={onTranscript} />);

        act(() => deepgram.lastOptions.onResult('partial text', false));
        act(() => deepgram.lastOptions.onResult('final text', true));

        expect(onTranscript).toHaveBeenNthCalledWith(1, 'partial text', false);
        expect(onTranscript).toHaveBeenNthCalledWith(2, 'final text', true);
    });

    it('shows an error and auto-dismisses it after 3s', () => {
        vi.useFakeTimers();
        try {
            render(<VoiceInput onTranscript={vi.fn()} />);

            act(() => deepgram.lastOptions.onError('Microphone access denied.'));
            expect(screen.getByText('Microphone access denied.')).toBeInTheDocument();

            act(() => vi.advanceTimersByTime(3000));
            expect(screen.queryByText('Microphone access denied.')).not.toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it('clears a visible error as soon as a transcript arrives', () => {
        render(<VoiceInput onTranscript={vi.fn()} />);

        act(() => deepgram.lastOptions.onError('Connection error to Deepgram'));
        expect(screen.getByText('Connection error to Deepgram')).toBeInTheDocument();

        act(() => deepgram.lastOptions.onResult('recovered', true));
        expect(screen.queryByText('Connection error to Deepgram')).not.toBeInTheDocument();
    });

    it('passes the store API key and continuous flag down to the recognizer', () => {
        resetStore({ deepgramApiKey: 'dg-key-from-store' });

        render(<VoiceInput onTranscript={vi.fn()} continuous />);

        expect(deepgram.lastOptions.deepgramApiKey).toBe('dg-key-from-store');
        expect(deepgram.lastOptions.continuous).toBe(true);
    });

    it('exposes stopListening through its imperative handle', () => {
        const ref = { current: null as VoiceInputHandle | null };
        render(<VoiceInput ref={ref} onTranscript={vi.fn()} />);

        act(() => ref.current!.stopListening());

        expect(deepgram.stopListening).toHaveBeenCalledTimes(1);
    });

    it('stops listening when unmounted mid-session', () => {
        deepgram.state.isListening = true;
        const { unmount } = render(<VoiceInput onTranscript={vi.fn()} />);

        unmount();

        expect(deepgram.stopListening).toHaveBeenCalled();
    });
});

// ===========================================================================
// GlobalVoiceToggle  (brief's "HeadphoneVoiceToggle")
// ===========================================================================

describe('GlobalVoiceToggle', () => {
    // The toggle's accessible name comes from its visible label ("Voice", plus
    // the target indicator once enabled), so `title` carries the state detail.
    const toggle = () => screen.getByRole('button', { name: /^voice/i });

    it('renders a disabled control when the browser has no microphone API', () => {
        installMic(false);

        render(<GlobalVoiceToggle />);

        expect(toggle()).toBeDisabled();
        expect(toggle()).toHaveAttribute(
            'title',
            'Voice input not supported in this browser'
        );
    });

    it('prompts for API-key setup when none is configured', () => {
        render(<GlobalVoiceToggle />);

        expect(toggle()).toBeEnabled();
        expect(toggle()).toHaveAttribute('title', 'Click to set up Deepgram API key');
    });

    it('opens the key modal instead of enabling voice when no key is set', async () => {
        const user = userEvent.setup();
        render(<GlobalVoiceToggle />);

        await user.click(toggle());

        expect(screen.getByRole('heading', { name: /deepgram api key required/i })).toBeInTheDocument();
        expect(useTaskStore.getState().globalVoiceEnabled).toBe(false);
    });

    it('enables voice mode once a key is saved through the modal', async () => {
        const user = userEvent.setup();
        render(<GlobalVoiceToggle />);

        await user.click(toggle());
        await user.type(screen.getByLabelText(/api key/i), 'dg-new-key');
        await user.click(screen.getByRole('button', { name: /save & enable voice/i }));

        expect(useTaskStore.getState().deepgramApiKey).toBe('dg-new-key');
        expect(useTaskStore.getState().globalVoiceEnabled).toBe(true);
    });

    it('does not enable voice mode if the modal is dismissed without a key', async () => {
        const user = userEvent.setup();
        render(<GlobalVoiceToggle />);

        await user.click(toggle());
        await user.click(screen.getByRole('button', { name: /^cancel$/i }));

        expect(useTaskStore.getState().globalVoiceEnabled).toBe(false);
    });

    it('turns voice mode on when a key is already configured', async () => {
        const user = userEvent.setup();
        resetStore({ deepgramApiKey: 'dg-key' });
        render(<GlobalVoiceToggle />);

        expect(toggle()).toHaveAttribute('title', 'Enable Voice Mode');
        await user.click(toggle());

        expect(useTaskStore.getState().globalVoiceEnabled).toBe(true);
    });

    it('turns voice mode off and discards the pending transcript', async () => {
        const user = userEvent.setup();
        resetStore({
            deepgramApiKey: 'dg-key',
            globalVoiceEnabled: true,
            voiceTranscript: 'half a sentence',
        });
        render(<GlobalVoiceToggle />);

        await user.click(toggle());

        expect(useTaskStore.getState().globalVoiceEnabled).toBe(false);
        expect(useTaskStore.getState().voiceTranscript).toBe('');
    });

    it('names the focused destination while voice mode is on', () => {
        resetStore({
            deepgramApiKey: 'dg-key',
            globalVoiceEnabled: true,
            focusedInputId: 'task-abc',
        });
        render(<GlobalVoiceToggle />);

        expect(toggle()).toHaveAttribute(
            'title',
            'Voice Mode ON - Speaking to: Task Input'
        );
        // The destination is visible on the button, not just in the tooltip.
        expect(within(toggle()).getByText('Task Input')).toBeInTheDocument();
    });

    it.each([
        ['new-task-1', 'New Task'],
        ['chat-1', 'Chat'],
        ['sidebar-search', 'Input'],
        [null, 'None'],
    ])('labels a %s focus as "%s"', (focusedInputId, expected) => {
        resetStore({ deepgramApiKey: 'dg-key', globalVoiceEnabled: true, focusedInputId });
        render(<GlobalVoiceToggle />);

        expect(toggle()).toHaveAttribute(
            'title',
            `Voice Mode ON - Speaking to: ${expected}`
        );
    });

    it('advertises the hands-free delay when auto-send is on', () => {
        resetStore({
            deepgramApiKey: 'dg-key',
            globalVoiceEnabled: true,
            autoSendEnabled: true,
            autoSendDelayMs: 2500,
        });
        render(<GlobalVoiceToggle />);

        expect(toggle().getAttribute('title')).toContain('Hands-Free (2.5s)');
    });
});

// ===========================================================================
// GlobalVoiceManager  (brief's "HeadphoneDeviceManager")
// ===========================================================================

describe('GlobalVoiceManager', () => {
    it('renders nothing — it is logic only', () => {
        const { container } = render(<GlobalVoiceManager />);

        expect(container).toBeEmptyDOMElement();
    });

    it('always requests continuous recognition with the store key', () => {
        resetStore({ deepgramApiKey: 'dg-key' });

        render(<GlobalVoiceManager />);

        expect(deepgram.lastOptions.continuous).toBe(true);
        expect(deepgram.lastOptions.interimResults).toBe(true);
        expect(deepgram.lastOptions.deepgramApiKey).toBe('dg-key');
    });

    it('does not start listening while global voice is off', () => {
        render(<GlobalVoiceManager />);

        expect(deepgram.startListening).not.toHaveBeenCalled();
    });

    it('starts listening when global voice is switched on', async () => {
        render(<GlobalVoiceManager />);

        act(() => useTaskStore.getState().setGlobalVoiceEnabled(true));

        await waitFor(() => expect(deepgram.startListening).toHaveBeenCalled());
    });

    it('stops listening when global voice is switched off', async () => {
        resetStore({ globalVoiceEnabled: true });
        deepgram.state.isListening = true;
        render(<GlobalVoiceManager />);

        act(() => useTaskStore.getState().setGlobalVoiceEnabled(false));

        await waitFor(() => expect(deepgram.stopListening).toHaveBeenCalled());
    });

    it('stays out of the way entirely when recognition is unsupported', () => {
        deepgram.state.isSupported = false;
        resetStore({ globalVoiceEnabled: true });

        render(<GlobalVoiceManager />);

        expect(deepgram.startListening).not.toHaveBeenCalled();
    });

    it('routes an interim transcript to the store without committing it', () => {
        render(<GlobalVoiceManager />);

        act(() => deepgram.lastOptions.onResult('half a sen', false));

        expect(useTaskStore.getState().voiceInterimTranscript).toBe('half a sen');
        expect(useTaskStore.getState().voiceTranscript).toBe('');
    });

    it('commits a final transcript and clears the interim buffer', () => {
        render(<GlobalVoiceManager />);

        act(() => deepgram.lastOptions.onResult('half a sen', false));
        act(() => deepgram.lastOptions.onResult('half a sentence', true));

        expect(useTaskStore.getState().voiceTranscript).toBe('half a sentence');
        expect(useTaskStore.getState().voiceInterimTranscript).toBe('');
    });

    it('space-joins successive final transcripts', () => {
        render(<GlobalVoiceManager />);

        act(() => deepgram.lastOptions.onResult('hello', true));
        act(() => deepgram.lastOptions.onResult('world', true));

        expect(useTaskStore.getState().voiceTranscript).toBe('hello world');
    });

    it('focuses the task input when speech arrives with nothing focused', () => {
        const input = document.createElement('input');
        input.setAttribute('data-input-type', 'task-input');
        document.body.appendChild(input);
        try {
            render(<GlobalVoiceManager />);

            act(() => deepgram.lastOptions.onResult('hello', true));

            expect(document.activeElement).toBe(input);
        } finally {
            input.remove();
        }
    });

    it('falls back to the new-task input when no task input exists', () => {
        const input = document.createElement('input');
        input.setAttribute('data-input-type', 'new-task-input');
        document.body.appendChild(input);
        try {
            render(<GlobalVoiceManager />);

            act(() => deepgram.lastOptions.onResult('hello', true));

            expect(document.activeElement).toBe(input);
        } finally {
            input.remove();
        }
    });

    describe('hands-free auto-send', () => {
        it('fires voice:autoSend for the focused input after the silence delay', () => {
            vi.useFakeTimers();
            const onAutoSend = vi.fn();
            window.addEventListener('voice:autoSend', onAutoSend);
            try {
                resetStore({ autoSendEnabled: true, autoSendDelayMs: 2000, focusedInputId: 'task-1' });
                render(<GlobalVoiceManager />);

                act(() => deepgram.lastOptions.onResult('send this', true));

                act(() => vi.advanceTimersByTime(1999));
                expect(onAutoSend).not.toHaveBeenCalled();

                act(() => vi.advanceTimersByTime(1));
                expect(onAutoSend).toHaveBeenCalledTimes(1);
                expect((onAutoSend.mock.calls[0][0] as CustomEvent).detail).toEqual({
                    inputId: 'task-1',
                });
            } finally {
                window.removeEventListener('voice:autoSend', onAutoSend);
                vi.useRealTimers();
            }
        });

        it('never auto-sends while hands-free mode is off', () => {
            vi.useFakeTimers();
            const onAutoSend = vi.fn();
            window.addEventListener('voice:autoSend', onAutoSend);
            try {
                resetStore({ autoSendEnabled: false, focusedInputId: 'task-1' });
                render(<GlobalVoiceManager />);

                act(() => deepgram.lastOptions.onResult('send this', true));
                act(() => vi.advanceTimersByTime(10000));

                expect(onAutoSend).not.toHaveBeenCalled();
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                window.removeEventListener('voice:autoSend', onAutoSend);
                vi.useRealTimers();
            }
        });

        it('never auto-sends when no input is focused', () => {
            vi.useFakeTimers();
            const onAutoSend = vi.fn();
            window.addEventListener('voice:autoSend', onAutoSend);
            try {
                resetStore({ autoSendEnabled: true, focusedInputId: null });
                render(<GlobalVoiceManager />);

                act(() => deepgram.lastOptions.onResult('send this', true));
                act(() => vi.advanceTimersByTime(10000));

                expect(onAutoSend).not.toHaveBeenCalled();
            } finally {
                window.removeEventListener('voice:autoSend', onAutoSend);
                vi.useRealTimers();
            }
        });

        it('a still-speaking interim result cancels the pending send', () => {
            vi.useFakeTimers();
            const onAutoSend = vi.fn();
            window.addEventListener('voice:autoSend', onAutoSend);
            try {
                resetStore({ autoSendEnabled: true, autoSendDelayMs: 2000, focusedInputId: 'task-1' });
                render(<GlobalVoiceManager />);

                act(() => deepgram.lastOptions.onResult('send this', true));
                act(() => vi.advanceTimersByTime(1500));

                // User resumed talking before the timer elapsed.
                act(() => deepgram.lastOptions.onResult('and more', false));
                act(() => vi.advanceTimersByTime(5000));

                expect(onAutoSend).not.toHaveBeenCalled();
            } finally {
                window.removeEventListener('voice:autoSend', onAutoSend);
                vi.useRealTimers();
            }
        });

        it('a later final restarts the silence window rather than stacking sends', () => {
            vi.useFakeTimers();
            const onAutoSend = vi.fn();
            window.addEventListener('voice:autoSend', onAutoSend);
            try {
                resetStore({ autoSendEnabled: true, autoSendDelayMs: 2000, focusedInputId: 'task-1' });
                render(<GlobalVoiceManager />);

                act(() => deepgram.lastOptions.onResult('first', true));
                act(() => vi.advanceTimersByTime(1500));
                act(() => deepgram.lastOptions.onResult('second', true));
                act(() => vi.advanceTimersByTime(1999));

                expect(onAutoSend).not.toHaveBeenCalled();

                act(() => vi.advanceTimersByTime(1));
                expect(onAutoSend).toHaveBeenCalledTimes(1);
            } finally {
                window.removeEventListener('voice:autoSend', onAutoSend);
                vi.useRealTimers();
            }
        });

        it('clears a pending send on unmount so it never fires', () => {
            vi.useFakeTimers();
            const onAutoSend = vi.fn();
            window.addEventListener('voice:autoSend', onAutoSend);
            try {
                resetStore({ autoSendEnabled: true, autoSendDelayMs: 2000, focusedInputId: 'task-1' });
                const { unmount } = render(<GlobalVoiceManager />);

                act(() => deepgram.lastOptions.onResult('send this', true));
                unmount();

                expect(vi.getTimerCount()).toBe(0);
                act(() => vi.advanceTimersByTime(10000));
                expect(onAutoSend).not.toHaveBeenCalled();
            } finally {
                window.removeEventListener('voice:autoSend', onAutoSend);
                vi.useRealTimers();
            }
        });
    });
});

// ===========================================================================
// DeepgramApiKeyModal
// ===========================================================================

describe('DeepgramApiKeyModal', () => {
    it('renders nothing while closed', () => {
        const { container } = render(<DeepgramApiKeyModal isOpen={false} onClose={vi.fn()} />);

        expect(container).toBeEmptyDOMElement();
    });

    it('explains what the key is for and links to signup', () => {
        render(<DeepgramApiKeyModal isOpen onClose={vi.fn()} />);

        expect(screen.getByRole('heading', { name: /deepgram api key required/i })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /console\.deepgram\.com\/signup/i })).toHaveAttribute(
            'href',
            'https://console.deepgram.com/signup'
        );
    });

    it('masks the key as it is typed', () => {
        render(<DeepgramApiKeyModal isOpen onClose={vi.fn()} />);

        expect(screen.getByLabelText(/api key/i)).toHaveAttribute('type', 'password');
    });

    it('pre-fills the key already in the store', () => {
        resetStore({ deepgramApiKey: 'existing-key' });

        render(<DeepgramApiKeyModal isOpen onClose={vi.fn()} />);

        expect(screen.getByLabelText(/api key/i)).toHaveValue('existing-key');
    });

    it('cannot save until something is typed', async () => {
        const user = userEvent.setup();
        render(<DeepgramApiKeyModal isOpen onClose={vi.fn()} />);

        const save = screen.getByRole('button', { name: /save & enable voice/i });
        expect(save).toBeDisabled();

        await user.type(screen.getByLabelText(/api key/i), 'k');
        expect(save).toBeEnabled();
    });

    it('stays disabled for whitespace-only input', async () => {
        const user = userEvent.setup();
        render(<DeepgramApiKeyModal isOpen onClose={vi.fn()} />);

        await user.type(screen.getByLabelText(/api key/i), '   ');

        expect(screen.getByRole('button', { name: /save & enable voice/i })).toBeDisabled();
    });

    it('saves a trimmed key to the store and closes', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<DeepgramApiKeyModal isOpen onClose={onClose} />);

        await user.type(screen.getByLabelText(/api key/i), '  dg-secret  ');
        await user.click(screen.getByRole('button', { name: /save & enable voice/i }));

        expect(useTaskStore.getState().deepgramApiKey).toBe('dg-secret');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('saves on Enter', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<DeepgramApiKeyModal isOpen onClose={onClose} />);

        await user.type(screen.getByLabelText(/api key/i), 'dg-secret{Enter}');

        expect(useTaskStore.getState().deepgramApiKey).toBe('dg-secret');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('discards the draft on Escape', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<DeepgramApiKeyModal isOpen onClose={onClose} />);

        await user.type(screen.getByLabelText(/api key/i), 'dg-secret{Escape}');

        expect(useTaskStore.getState().deepgramApiKey).toBe('');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('discards the draft on Cancel', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<DeepgramApiKeyModal isOpen onClose={onClose} />);

        await user.type(screen.getByLabelText(/api key/i), 'dg-secret');
        await user.click(screen.getByRole('button', { name: /^cancel$/i }));

        expect(useTaskStore.getState().deepgramApiKey).toBe('');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes on a backdrop click but not on a click inside the dialog', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<DeepgramApiKeyModal isOpen onClose={onClose} />);

        await user.click(screen.getByLabelText(/api key/i));
        expect(onClose).not.toHaveBeenCalled();

        // The heading's outermost ancestor is the backdrop.
        await user.click(document.querySelector('.modal-overlay') as HTMLElement);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

// ===========================================================================
// VoiceSettingsContent
// ===========================================================================

describe('VoiceSettingsContent', () => {
    /** The API-key box is the only password field on the panel. */
    const apiKeyBox = () => screen.getByPlaceholderText(/enter deepgram api key/i);

    it('tells the user a key is needed before anything else works', () => {
        render(<VoiceSettingsContent />);

        expect(screen.getByText(/enter a deepgram api key to enable voice recognition/i))
            .toBeInTheDocument();
        expect(screen.getByLabelText(/enable always-listening mode/i)).toBeDisabled();
    });

    it('persists the API key to the store as it is typed', async () => {
        const user = userEvent.setup();
        render(<VoiceSettingsContent />);

        await user.type(apiKeyBox(), 'dg-abc');

        expect(useTaskStore.getState().deepgramApiKey).toBe('dg-abc');
    });

    it('unlocks always-listening mode once a key exists', () => {
        resetStore({ deepgramApiKey: 'dg-key' });

        render(<VoiceSettingsContent />);

        expect(screen.getByLabelText(/enable always-listening mode/i)).toBeEnabled();
        expect(screen.getByText(/deepgram nova-3 will be used/i)).toBeInTheDocument();
    });

    it('keeps always-listening disabled when the browser has no microphone', () => {
        installMic(false);
        resetStore({ deepgramApiKey: 'dg-key' });

        render(<VoiceSettingsContent />);

        expect(screen.getByLabelText(/enable always-listening mode/i)).toBeDisabled();
        expect(screen.getByText(/microphone not available in this browser/i)).toBeInTheDocument();
    });

    it('toggles always-listening mode into the store', async () => {
        const user = userEvent.setup();
        resetStore({ deepgramApiKey: 'dg-key' });
        render(<VoiceSettingsContent />);

        await user.click(screen.getByLabelText(/enable always-listening mode/i));

        expect(useTaskStore.getState().globalVoiceEnabled).toBe(true);
    });

    it('gates hands-free mode behind always-listening mode', () => {
        resetStore({ deepgramApiKey: 'dg-key', globalVoiceEnabled: false });

        render(<VoiceSettingsContent />);

        expect(screen.getByLabelText(/enable hands-free mode/i)).toBeDisabled();
        expect(
            screen.getByText(/enable always-listening mode above to use hands-free mode/i)
        ).toBeInTheDocument();
    });

    it('toggles hands-free mode into the store, preserving the delay', async () => {
        const user = userEvent.setup();
        resetStore({ deepgramApiKey: 'dg-key', globalVoiceEnabled: true, autoSendDelayMs: 2000 });
        render(<VoiceSettingsContent />);

        await user.click(screen.getByLabelText(/enable hands-free mode/i));

        expect(useTaskStore.getState().autoSendEnabled).toBe(true);
        expect(useTaskStore.getState().autoSendDelayMs).toBe(2000);
    });

    it('reveals the auto-send delay slider only in hands-free mode', () => {
        resetStore({ deepgramApiKey: 'dg-key', globalVoiceEnabled: true, autoSendEnabled: false });
        const { rerender } = render(<VoiceSettingsContent />);

        expect(screen.queryByText(/auto-send delay/i)).not.toBeInTheDocument();

        act(() => useTaskStore.getState().setAutoSendSettings(true, 3000));
        rerender(<VoiceSettingsContent />);

        expect(screen.getByText(/auto-send delay: 3\.0s/i)).toBeInTheDocument();
    });

    it('debounces the auto-send delay slider before writing to the store', () => {
        vi.useFakeTimers();
        try {
            resetStore({
                deepgramApiKey: 'dg-key',
                globalVoiceEnabled: true,
                autoSendEnabled: true,
                autoSendDelayMs: 3000,
            });
            render(<VoiceSettingsContent />);

            // Sliders carry no accessible name, so identify the auto-send one
            // by its unique range (0.5–5s) rather than by position alone.
            const slider = screen
                .getAllByRole('slider')
                .find((s) => s.getAttribute('min') === '0.5' && s.getAttribute('max') === '5')!;
            expect(slider).toBeDefined();
            fireEvent.change(slider, { target: { value: '1.5' } });

            // Label reflects the new value immediately...
            expect(screen.getByText(/auto-send delay: 1\.5s/i)).toBeInTheDocument();
            // ...but the store is untouched until the debounce elapses.
            expect(useTaskStore.getState().autoSendDelayMs).toBe(3000);

            act(() => vi.advanceTimersByTime(500));
            expect(useTaskStore.getState().autoSendDelayMs).toBe(1500);
        } finally {
            vi.useRealTimers();
        }
    });

    it('gates completion summaries and progress updates behind always-listening', () => {
        resetStore({ deepgramApiKey: 'dg-key', globalVoiceEnabled: false });

        render(<VoiceSettingsContent />);

        expect(screen.getByLabelText(/announce task summaries when complete/i)).toBeDisabled();
        expect(screen.getByLabelText(/announce progress for long-running tasks/i)).toBeDisabled();
    });

    it('toggles completion summaries into the store', async () => {
        const user = userEvent.setup();
        resetStore({ deepgramApiKey: 'dg-key', globalVoiceEnabled: true });
        render(<VoiceSettingsContent />);

        await user.click(screen.getByLabelText(/announce task summaries when complete/i));

        expect(useTaskStore.getState().voiceSummaryOnCompletion).toBe(true);
    });

    it('toggles progress updates into the store and reveals their interval', async () => {
        const user = userEvent.setup();
        resetStore({ deepgramApiKey: 'dg-key', globalVoiceEnabled: true });
        const { rerender } = render(<VoiceSettingsContent />);

        expect(screen.queryByText(/update interval:/i)).not.toBeInTheDocument();

        await user.click(screen.getByLabelText(/announce progress for long-running tasks/i));
        rerender(<VoiceSettingsContent />);

        expect(useTaskStore.getState().voiceProgressUpdatesEnabled).toBe(true);
        expect(screen.getByText(/update interval: 3m 0s/i)).toBeInTheDocument();
    });

    it('toggles the thinking sound and reveals its interval', async () => {
        const user = userEvent.setup();
        render(<VoiceSettingsContent />);

        expect(screen.queryByText(/sound interval:/i)).not.toBeInTheDocument();

        await user.click(screen.getByLabelText(/play sound when claude is thinking/i));

        expect(useTaskStore.getState().thinkingSoundEnabled).toBe(true);
        expect(screen.getByText(/sound interval: 5\.0s/i)).toBeInTheDocument();
    });

    it('toggles the legacy microphone buttons', async () => {
        const user = userEvent.setup();
        render(<VoiceSettingsContent />);

        await user.click(screen.getByLabelText(/show microphone buttons/i));

        expect(useTaskStore.getState().voiceEnabled).toBe(true);
    });

    it('toggles auto-speak responses', async () => {
        const user = userEvent.setup();
        render(<VoiceSettingsContent />);

        await user.click(screen.getByLabelText(/auto-speak responses/i));

        expect(useTaskStore.getState().autoSpeakResponses).toBe(true);
    });

    it('disables the voice picker while no voices have loaded', () => {
        render(<VoiceSettingsContent />);

        const select = screen.getByRole('combobox');
        expect(select).toBeDisabled();
        expect(within(select).getByRole('option', { name: /loading voices/i })).toBeInTheDocument();
    });

    it('lists loaded voices and defaults to the engine default', () => {
        synthesis.voices = [
            { name: 'Samantha', lang: 'en-US', default: false },
            { name: 'Daniel', lang: 'en-GB', default: true },
        ];

        render(<VoiceSettingsContent />);

        const select = screen.getByRole('combobox');
        expect(select).toBeEnabled();
        expect(within(select).getByRole('option', { name: 'Samantha (en-US)' })).toBeInTheDocument();
        expect(select).toHaveValue('Daniel');
    });

    it('saves a voice choice to the store immediately', async () => {
        const user = userEvent.setup();
        synthesis.voices = [
            { name: 'Samantha', lang: 'en-US', default: true },
            { name: 'Daniel', lang: 'en-GB', default: false },
        ];
        render(<VoiceSettingsContent />);

        await user.selectOptions(screen.getByRole('combobox'), 'Daniel');

        expect(useTaskStore.getState().selectedVoiceName).toBe('Daniel');
    });

    it('shows the current rate, pitch and volume from the store', () => {
        resetStore({ voiceRate: 1.4, voicePitch: 0.8, voiceVolume: 0.3 });

        render(<VoiceSettingsContent />);

        expect(screen.getByText(/speed: 1\.4x/i)).toBeInTheDocument();
        expect(screen.getByText(/pitch: 0\.8/i)).toBeInTheDocument();
        expect(screen.getByText(/volume: 30%/i)).toBeInTheDocument();
    });

    it('speaks a sample when the test button is pressed', async () => {
        const user = userEvent.setup();
        render(<VoiceSettingsContent />);

        await user.click(screen.getByRole('button', { name: /test voice/i }));

        expect(synthesis.speak).toHaveBeenCalledWith(
            'Hello! This is how I sound with the current voice settings.'
        );
    });
});

// ===========================================================================
// TaskCompletionVoiceManager
// (stands in for the brief's non-existent "VoiceWorkspaceManager")
// ===========================================================================

describe('TaskCompletionVoiceManager', () => {
    const enabled = { voiceSummaryOnCompletion: true, globalVoiceEnabled: true };

    /** Render, then move a task from busy → idle to trigger an announcement. */
    async function completeTask(storeOverrides: Record<string, unknown> = {}) {
        resetStore({
            ...storeOverrides,
            tasks: new Map([['task-1', makeTask({ state: 'busy' })]]),
        });
        const view = render(<TaskCompletionVoiceManager />);

        await act(async () => {
            useTaskStore.setState({
                tasks: new Map([['task-1', makeTask({ state: 'idle' })]]),
            });
        });
        return view;
    }

    function conversationResponse(messages: unknown[]) {
        return vi.fn(async () => ({
            ok: true,
            status: 200,
            json: async () => ({ messages }),
        })) as any;
    }

    it('renders nothing — it is logic only', () => {
        const { container } = render(<TaskCompletionVoiceManager />);

        expect(container).toBeEmptyDOMElement();
    });

    it('stays silent when the feature is off', async () => {
        await completeTask({ voiceSummaryOnCompletion: false, globalVoiceEnabled: true });

        expect(elevenLabs.speak).not.toHaveBeenCalled();
    });

    it('stays silent when global voice mode is off', async () => {
        await completeTask({ voiceSummaryOnCompletion: true, globalVoiceEnabled: false });

        expect(elevenLabs.speak).not.toHaveBeenCalled();
    });

    it('announces the task name plus the last assistant message', async () => {
        global.fetch = conversationResponse([
            { role: 'user', content: 'do it' },
            { role: 'assistant', content: 'All done, tests pass.' },
        ]);

        await completeTask(enabled);

        await waitFor(() =>
            expect(elevenLabs.speak).toHaveBeenCalledWith(
                'do the thing completed. All done, tests pass.'
            )
        );
    });

    it('prefers the display name over the raw prompt', async () => {
        global.fetch = conversationResponse([{ role: 'assistant', content: 'Finished.' }]);
        resetStore({
            ...enabled,
            tasks: new Map([['task-1', makeTask({ state: 'busy', displayName: 'Fix login bug' })]]),
        });
        render(<TaskCompletionVoiceManager />);

        await act(async () => {
            useTaskStore.setState({
                tasks: new Map([
                    ['task-1', makeTask({ state: 'idle', displayName: 'Fix login bug' })],
                ]),
            });
        });

        await waitFor(() =>
            expect(elevenLabs.speak).toHaveBeenCalledWith('Fix login bug completed. Finished.')
        );
    });

    it('strips markdown so the summary reads cleanly aloud', async () => {
        global.fetch = conversationResponse([
            {
                role: 'assistant',
                content:
                    'Fixed **auth** and `login()`. See ```js\nconst x = 1;\n``` plus [the docs](http://x.dev).',
            },
        ]);

        await completeTask(enabled);

        await waitFor(() => expect(elevenLabs.speak).toHaveBeenCalled());
        const spoken = elevenLabs.speak.mock.calls[0][0] as string;
        expect(spoken).toContain('Fixed auth and code.');
        expect(spoken).toContain('code block');
        expect(spoken).toContain('the docs');
        expect(spoken).not.toContain('**');
        expect(spoken).not.toContain('```');
        expect(spoken).not.toContain('http://x.dev');
    });

    it('truncates a long summary', async () => {
        global.fetch = conversationResponse([{ role: 'assistant', content: 'x'.repeat(500) }]);

        await completeTask(enabled);

        await waitFor(() => expect(elevenLabs.speak).toHaveBeenCalled());
        const spoken = elevenLabs.speak.mock.calls[0][0] as string;
        expect(spoken).toBe(`do the thing completed. ${'x'.repeat(200)}...`);
    });

    it('announces just the name when there is no assistant message', async () => {
        global.fetch = conversationResponse([{ role: 'user', content: 'do it' }]);

        await completeTask(enabled);

        await waitFor(() =>
            expect(elevenLabs.speak).toHaveBeenCalledWith('do the thing completed.')
        );
    });

    it('still announces when the conversation fetch fails', async () => {
        global.fetch = vi.fn(async () => {
            throw new Error('offline');
        }) as any;

        await completeTask(enabled);

        await waitFor(() =>
            expect(elevenLabs.speak).toHaveBeenCalledWith('do the thing completed.')
        );
    });

    it('cancels any in-flight speech before announcing', async () => {
        global.fetch = conversationResponse([{ role: 'assistant', content: 'Done.' }]);

        await completeTask(enabled);

        await waitFor(() => expect(elevenLabs.cancel).toHaveBeenCalled());
    });

    it('does not announce an idle task that was never busy', async () => {
        global.fetch = conversationResponse([{ role: 'assistant', content: 'Done.' }]);
        resetStore({ ...enabled, tasks: new Map() });
        render(<TaskCompletionVoiceManager />);

        await act(async () => {
            useTaskStore.setState({
                tasks: new Map([['task-1', makeTask({ state: 'idle' })]]),
            });
        });

        expect(elevenLabs.speak).not.toHaveBeenCalled();
    });

    it('announces each completion once, not on every unrelated re-render', async () => {
        global.fetch = conversationResponse([{ role: 'assistant', content: 'Done.' }]);

        await completeTask(enabled);
        await waitFor(() => expect(elevenLabs.speak).toHaveBeenCalledTimes(1));

        // An unrelated store update re-runs the effect with the same task map.
        await act(async () => {
            useTaskStore.setState({
                tasks: new Map([['task-1', makeTask({ state: 'idle' })]]),
            });
        });

        expect(elevenLabs.speak).toHaveBeenCalledTimes(1);
    });

    it('announces a second, later completion of the same task', async () => {
        global.fetch = conversationResponse([{ role: 'assistant', content: 'Done.' }]);

        await completeTask(enabled);
        await waitFor(() => expect(elevenLabs.speak).toHaveBeenCalledTimes(1));

        await act(async () => {
            useTaskStore.setState({
                tasks: new Map([['task-1', makeTask({ state: 'busy' })]]),
            });
        });
        await act(async () => {
            useTaskStore.setState({
                tasks: new Map([
                    [
                        'task-1',
                        makeTask({
                            state: 'idle',
                            lastActivity: new Date('2026-01-01T00:05:00Z'),
                        }),
                    ],
                ]),
            });
        });

        await waitFor(() => expect(elevenLabs.speak).toHaveBeenCalledTimes(2));
    });
});
