/**
 * Voice hooks — the four browser-API wrappers behind Claudia's voice mode.
 *
 *   useVoiceRecognition   → Web Speech API (window.SpeechRecognition)
 *   useDeepgramRecognition→ getUserMedia + MediaRecorder + WebSocket to Deepgram
 *   useSpeechSynthesis    → window.speechSynthesis
 *   useElevenLabsTTS      → fetch → Blob → Audio
 *
 * None of these APIs exist in jsdom, so each suite installs a hand-rolled fake
 * that records calls and lets the test fire events on demand. Everything
 * time-based runs on fake timers — no sleeping, and unmount leaks are asserted
 * via vi.getTimerCount().
 *
 * Teardown order matters: RTL's auto-cleanup afterEach runs AFTER ours, so a
 * component unmounting late would call into globals we already restored. Every
 * afterEach here calls cleanup() FIRST, then restores.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

vi.mock('../../config/api-config', () => ({
    getApiBaseUrl: () => 'http://claudia.test:9999',
    getWebSocketUrl: () => 'ws://claudia.test:9999',
    isTunnelAccess: () => false,
    getMobileToken: () => null,
    isElectron: () => false,
}));

import { useVoiceRecognition } from '../useVoiceRecognition';
import { useDeepgramRecognition } from '../useDeepgramRecognition';
import { useSpeechSynthesis } from '../useSpeechSynthesis';
import { useElevenLabsTTS } from '../useElevenLabsTTS';

// Hooks log heavily on every state transition; silence it so failures are readable.
beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ===========================================================================
// useVoiceRecognition — Web Speech API
// ===========================================================================

/** Mirrors the SpeechRecognition surface the hook actually touches. */
class FakeSpeechRecognition {
    static instances: FakeSpeechRecognition[] = [];
    static reset() {
        FakeSpeechRecognition.instances = [];
    }
    static get last(): FakeSpeechRecognition {
        const r = FakeSpeechRecognition.instances[FakeSpeechRecognition.instances.length - 1];
        if (!r) throw new Error('no FakeSpeechRecognition constructed');
        return r;
    }

    continuous = false;
    interimResults = false;
    lang = '';
    maxAlternatives = 1;

    startCount = 0;
    stopCount = 0;
    abortCount = 0;
    /** When set, start() throws it — models "already started" / InvalidStateError. */
    startError: Error | null = null;

    onresult: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onend: (() => void) | null = null;
    onstart: (() => void) | null = null;

    constructor() {
        FakeSpeechRecognition.instances.push(this);
    }

    start() {
        if (this.startError) throw this.startError;
        this.startCount++;
    }
    stop() {
        this.stopCount++;
    }
    abort() {
        this.abortCount++;
    }

    // --- test drivers ------------------------------------------------------

    fireResult(items: Array<{ transcript: string; isFinal: boolean }>, resultIndex = 0) {
        const results: any = items.map((i) => {
            const alternatives: any = [{ transcript: i.transcript }];
            alternatives.isFinal = i.isFinal;
            return alternatives;
        });
        this.onresult?.({ results, resultIndex });
    }

    fireError(error: string) {
        this.onerror?.({ error });
    }

    fireEnd() {
        this.onend?.();
    }
}

describe('useVoiceRecognition', () => {
    beforeEach(() => {
        FakeSpeechRecognition.reset();
        (window as any).SpeechRecognition = FakeSpeechRecognition;
        delete (window as any).webkitSpeechRecognition;
    });

    afterEach(() => {
        cleanup();
        delete (window as any).SpeechRecognition;
        delete (window as any).webkitSpeechRecognition;
        vi.restoreAllMocks();
    });

    it('reports unsupported and never constructs a recognizer when the API is absent', () => {
        delete (window as any).SpeechRecognition;

        const { result } = renderHook(() => useVoiceRecognition());

        expect(result.current.isSupported).toBe(false);
        expect(FakeSpeechRecognition.instances).toHaveLength(0);
    });

    it('falls back to the webkit-prefixed constructor', () => {
        delete (window as any).SpeechRecognition;
        (window as any).webkitSpeechRecognition = FakeSpeechRecognition;

        const { result } = renderHook(() => useVoiceRecognition());

        expect(result.current.isSupported).toBe(true);
        expect(FakeSpeechRecognition.instances).toHaveLength(1);
    });

    it('applies the caller\'s config to the recognizer', () => {
        renderHook(() =>
            useVoiceRecognition({ continuous: true, interimResults: false, language: 'fr-FR' })
        );

        const rec = FakeSpeechRecognition.last;
        expect(rec.continuous).toBe(true);
        expect(rec.interimResults).toBe(false);
        expect(rec.lang).toBe('fr-FR');
    });

    it('starts and stops, notifying the listening-change callback both ways', () => {
        const onListeningChange = vi.fn();
        const { result } = renderHook(() => useVoiceRecognition({ onListeningChange }));

        act(() => result.current.startListening());

        expect(FakeSpeechRecognition.last.startCount).toBe(1);
        expect(result.current.isListening).toBe(true);
        expect(onListeningChange).toHaveBeenLastCalledWith(true);

        act(() => result.current.stopListening());

        expect(FakeSpeechRecognition.last.stopCount).toBe(1);
        expect(result.current.isListening).toBe(false);
        expect(onListeningChange).toHaveBeenLastCalledWith(false);
    });

    it('ignores a second startListening while already listening', () => {
        const { result } = renderHook(() => useVoiceRecognition());

        act(() => result.current.startListening());
        act(() => result.current.startListening());

        expect(FakeSpeechRecognition.last.startCount).toBe(1);
    });

    it('reports an error and stays stopped when start() throws', () => {
        const onError = vi.fn();
        const { result } = renderHook(() => useVoiceRecognition({ onError }));

        FakeSpeechRecognition.last.startError = new Error('InvalidStateError');
        act(() => result.current.startListening());

        expect(onError).toHaveBeenCalledWith('Failed to start voice recognition');
        expect(result.current.isListening).toBe(false);
    });

    it('surfaces interim results without committing them to the transcript', () => {
        const onResult = vi.fn();
        const { result } = renderHook(() => useVoiceRecognition({ onResult }));

        act(() => FakeSpeechRecognition.last.fireResult([{ transcript: 'hello wor', isFinal: false }]));

        expect(result.current.interimTranscript).toBe('hello wor');
        expect(result.current.transcript).toBe('');
        expect(onResult).toHaveBeenCalledWith('hello wor', false);
    });

    it('commits a final result and clears the interim buffer', () => {
        const onResult = vi.fn();
        const { result } = renderHook(() => useVoiceRecognition({ onResult }));

        act(() => FakeSpeechRecognition.last.fireResult([{ transcript: 'interim', isFinal: false }]));
        act(() => FakeSpeechRecognition.last.fireResult([{ transcript: 'hello world', isFinal: true }]));

        expect(result.current.transcript).toBe('hello world');
        expect(result.current.interimTranscript).toBe('');
        expect(onResult).toHaveBeenLastCalledWith('hello world', true);
    });

    it('replaces (not accumulates) finals in one-shot mode', () => {
        const { result } = renderHook(() => useVoiceRecognition({ continuous: false }));

        act(() => FakeSpeechRecognition.last.fireResult([{ transcript: 'first', isFinal: true }]));
        act(() => FakeSpeechRecognition.last.fireResult([{ transcript: 'second', isFinal: true }]));

        expect(result.current.transcript).toBe('second');
    });

    it('accumulates finals across events in continuous mode', () => {
        const { result } = renderHook(() => useVoiceRecognition({ continuous: true }));

        act(() => result.current.startListening());
        act(() => FakeSpeechRecognition.last.fireResult([{ transcript: 'first ', isFinal: true }]));
        act(() => FakeSpeechRecognition.last.fireResult([{ transcript: 'second', isFinal: true }]));

        expect(result.current.transcript).toBe('first second');
    });

    it('concatenates multiple results in one event and splits final from interim', () => {
        const onResult = vi.fn();
        const { result } = renderHook(() => useVoiceRecognition({ onResult }));

        act(() =>
            FakeSpeechRecognition.last.fireResult([
                { transcript: 'done ', isFinal: true },
                { transcript: 'pending', isFinal: false },
            ])
        );

        expect(result.current.transcript).toBe('done ');
        expect(result.current.interimTranscript).toBe('pending');
        expect(onResult).toHaveBeenCalledWith('done ', true);
        expect(onResult).toHaveBeenCalledWith('pending', false);
    });

    it('honours resultIndex and skips already-delivered results', () => {
        const { result } = renderHook(() => useVoiceRecognition());

        act(() =>
            FakeSpeechRecognition.last.fireResult(
                [
                    { transcript: 'OLD', isFinal: true },
                    { transcript: 'NEW', isFinal: true },
                ],
                1
            )
        );

        expect(result.current.transcript).toBe('NEW');
    });

    it('resetTranscript clears both buffers and the accumulator', () => {
        const { result } = renderHook(() => useVoiceRecognition({ continuous: true }));

        act(() => result.current.startListening());
        act(() => FakeSpeechRecognition.last.fireResult([{ transcript: 'abc', isFinal: true }]));
        act(() => result.current.resetTranscript());

        expect(result.current.transcript).toBe('');
        expect(result.current.interimTranscript).toBe('');

        // Accumulator really was reset — the next final does not re-append to "abc".
        act(() => FakeSpeechRecognition.last.fireResult([{ transcript: 'xyz', isFinal: true }]));
        expect(result.current.transcript).toBe('xyz');
    });

    describe('error handling', () => {
        it('swallows no-speech, which is normal silence in continuous mode', () => {
            const onError = vi.fn();
            renderHook(() => useVoiceRecognition({ onError, continuous: true }));

            act(() => FakeSpeechRecognition.last.fireError('no-speech'));

            expect(onError).not.toHaveBeenCalled();
        });

        it('swallows aborted, which is what a manual stop looks like', () => {
            const onError = vi.fn();
            renderHook(() => useVoiceRecognition({ onError }));

            act(() => FakeSpeechRecognition.last.fireError('aborted'));

            expect(onError).not.toHaveBeenCalled();
        });

        it('reports a network error but keeps listening', () => {
            const onError = vi.fn();
            const onListeningChange = vi.fn();
            const { result } = renderHook(() => useVoiceRecognition({ onError, onListeningChange }));

            act(() => result.current.startListening());
            onListeningChange.mockClear();
            act(() => FakeSpeechRecognition.last.fireError('network'));

            expect(onError).toHaveBeenCalledWith('Network error occurred.');
            expect(result.current.isListening).toBe(true);
            expect(onListeningChange).not.toHaveBeenCalled();
        });

        it('treats permission denial as fatal and stops listening', () => {
            const onError = vi.fn();
            const onListeningChange = vi.fn();
            const { result } = renderHook(() => useVoiceRecognition({ onError, onListeningChange }));

            act(() => result.current.startListening());
            act(() => FakeSpeechRecognition.last.fireError('not-allowed'));

            expect(onError).toHaveBeenCalledWith(
                'Microphone access denied. Please allow microphone access.'
            );
            expect(result.current.isListening).toBe(false);
            expect(onListeningChange).toHaveBeenLastCalledWith(false);
        });

        it('treats audio-capture as fatal and stops listening', () => {
            const onError = vi.fn();
            const { result } = renderHook(() => useVoiceRecognition({ onError }));

            act(() => result.current.startListening());
            act(() => FakeSpeechRecognition.last.fireError('audio-capture'));

            expect(onError).toHaveBeenCalledWith('Microphone not found or not accessible.');
            expect(result.current.isListening).toBe(false);
        });

        it('passes through an unrecognised error code verbatim', () => {
            const onError = vi.fn();
            renderHook(() => useVoiceRecognition({ onError }));

            act(() => FakeSpeechRecognition.last.fireError('service-not-allowed'));

            expect(onError).toHaveBeenCalledWith(
                'Speech recognition error: service-not-allowed'
            );
        });
    });

    describe('continuous-mode restart on onend', () => {
        it('restarts immediately so silence does not end the session', () => {
            const { result } = renderHook(() => useVoiceRecognition({ continuous: true }));

            act(() => result.current.startListening());
            expect(FakeSpeechRecognition.last.startCount).toBe(1);

            act(() => FakeSpeechRecognition.last.fireEnd());

            expect(FakeSpeechRecognition.last.startCount).toBe(2);
            expect(result.current.isListening).toBe(true);
        });

        it('does not restart after an explicit stop', () => {
            const { result } = renderHook(() => useVoiceRecognition({ continuous: true }));

            act(() => result.current.startListening());
            act(() => result.current.stopListening());
            const startsBefore = FakeSpeechRecognition.last.startCount;

            act(() => FakeSpeechRecognition.last.fireEnd());

            expect(FakeSpeechRecognition.last.startCount).toBe(startsBefore);
            expect(result.current.isListening).toBe(false);
        });

        it('does not restart in one-shot mode; it just goes idle', () => {
            const onListeningChange = vi.fn();
            const { result } = renderHook(() =>
                useVoiceRecognition({ continuous: false, onListeningChange })
            );

            act(() => result.current.startListening());
            act(() => FakeSpeechRecognition.last.fireEnd());

            expect(FakeSpeechRecognition.last.startCount).toBe(1);
            expect(result.current.isListening).toBe(false);
            expect(onListeningChange).toHaveBeenLastCalledWith(false);
        });

        it('retries on a 100ms timer when the immediate restart throws', () => {
            vi.useFakeTimers();
            try {
                const { result } = renderHook(() => useVoiceRecognition({ continuous: true }));
                const rec = FakeSpeechRecognition.last;

                act(() => result.current.startListening());
                rec.startError = new Error('already started');

                act(() => rec.fireEnd());
                // Immediate restart threw; a delayed retry is now pending.
                expect(vi.getTimerCount()).toBe(1);

                rec.startError = null;
                act(() => vi.advanceTimersByTime(100));

                expect(rec.startCount).toBe(2);
                expect(result.current.isListening).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });

        it('gives up after repeated restart failures instead of looping forever', () => {
            vi.useFakeTimers();
            try {
                const onListeningChange = vi.fn();
                const { result } = renderHook(() =>
                    useVoiceRecognition({ continuous: true, onListeningChange })
                );
                const rec = FakeSpeechRecognition.last;

                act(() => result.current.startListening());
                rec.startError = new Error('always fails');

                // Each onend burns one immediate attempt plus one delayed attempt.
                for (let i = 0; i < 3; i++) {
                    act(() => rec.fireEnd());
                    act(() => vi.advanceTimersByTime(100));
                }

                expect(result.current.isListening).toBe(false);
                expect(onListeningChange).toHaveBeenLastCalledWith(false);
                // No retry timer left armed.
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    it('stops the recognizer on unmount and leaves no pending timers', () => {
        vi.useFakeTimers();
        try {
            const { result, unmount } = renderHook(() => useVoiceRecognition({ continuous: true }));
            const rec = FakeSpeechRecognition.last;

            act(() => result.current.startListening());
            unmount();

            expect(rec.stopCount).toBe(1);
            expect(vi.getTimerCount()).toBe(0);

            // A late onend from the dead recognizer must not resurrect it.
            act(() => rec.fireEnd());
            expect(rec.startCount).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rebuilds the recognizer when config changes, tearing the old one down', () => {
        const { rerender } = renderHook(({ lang }) => useVoiceRecognition({ language: lang }), {
            initialProps: { lang: 'en-US' },
        });

        expect(FakeSpeechRecognition.instances).toHaveLength(1);
        const first = FakeSpeechRecognition.last;

        rerender({ lang: 'de-DE' });

        expect(FakeSpeechRecognition.instances).toHaveLength(2);
        expect(first.stopCount).toBe(1);
        expect(FakeSpeechRecognition.last.lang).toBe('de-DE');
    });

    it('does not rebuild the recognizer when only callbacks change identity', () => {
        const { rerender } = renderHook(
            ({ cb }: { cb: (transcript: string, isFinal: boolean) => void }) =>
                useVoiceRecognition({ onResult: cb }),
            { initialProps: { cb: vi.fn() } },
        );

        rerender({ cb: vi.fn() });

        expect(FakeSpeechRecognition.instances).toHaveLength(1);
    });

    it('routes results to the latest callback after a re-render', () => {
        const first = vi.fn();
        const second = vi.fn();
        const { rerender } = renderHook(({ cb }) => useVoiceRecognition({ onResult: cb }), {
            initialProps: { cb: first },
        });

        rerender({ cb: second });
        act(() => FakeSpeechRecognition.last.fireResult([{ transcript: 'hi', isFinal: true }]));

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledWith('hi', true);
    });
});

// ===========================================================================
// useSpeechSynthesis — window.speechSynthesis
// ===========================================================================

class FakeUtterance {
    static instances: FakeUtterance[] = [];
    static get last(): FakeUtterance {
        const u = FakeUtterance.instances[FakeUtterance.instances.length - 1];
        if (!u) throw new Error('no FakeUtterance constructed');
        return u;
    }

    text: string;
    voice: any = null;
    rate = 1;
    pitch = 1;
    volume = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: any) => void) | null = null;

    constructor(text: string) {
        this.text = text;
        FakeUtterance.instances.push(this);
    }
}

function makeVoice(name: string, lang: string, isDefault = false) {
    return { name, lang, default: isDefault, localService: true, voiceURI: name };
}

class FakeSpeechSynthesis {
    speaking = false;
    paused = false;
    pending = false;
    onvoiceschanged: (() => void) | null = null;

    voices: any[] = [];
    spoken: FakeUtterance[] = [];
    cancelCount = 0;
    pauseCount = 0;
    resumeCount = 0;
    /** When set, speak() throws it. */
    speakError: Error | null = null;

    getVoices() {
        return this.voices;
    }
    speak(u: FakeUtterance) {
        if (this.speakError) throw this.speakError;
        this.spoken.push(u);
        this.speaking = true;
    }
    cancel() {
        this.cancelCount++;
        this.speaking = false;
        this.paused = false;
    }
    pause() {
        this.pauseCount++;
        this.paused = true;
    }
    resume() {
        this.resumeCount++;
        this.paused = false;
    }
}

describe('useSpeechSynthesis', () => {
    let synth: FakeSpeechSynthesis;

    beforeEach(() => {
        FakeUtterance.instances = [];
        synth = new FakeSpeechSynthesis();
        (window as any).speechSynthesis = synth;
        (window as any).SpeechSynthesisUtterance = FakeUtterance;
        (globalThis as any).SpeechSynthesisUtterance = FakeUtterance;
    });

    afterEach(() => {
        cleanup();
        delete (window as any).speechSynthesis;
        delete (window as any).SpeechSynthesisUtterance;
        delete (globalThis as any).SpeechSynthesisUtterance;
        vi.restoreAllMocks();
    });

    it('reports unsupported when speechSynthesis is missing', () => {
        delete (window as any).speechSynthesis;

        const { result } = renderHook(() => useSpeechSynthesis());

        expect(result.current.isSupported).toBe(false);
        expect(result.current.voices).toEqual([]);
    });

    it('loads voices and auto-selects an English one', () => {
        synth.voices = [makeVoice('Anna', 'de-DE'), makeVoice('Samantha', 'en-US')];

        const { result } = renderHook(() => useSpeechSynthesis());

        expect(result.current.isSupported).toBe(true);
        expect(result.current.voices).toHaveLength(2);
        expect(result.current.selectedVoice?.name).toBe('Samantha');
    });

    it('falls back to the first voice when none are English', () => {
        synth.voices = [makeVoice('Anna', 'de-DE'), makeVoice('Yuki', 'ja-JP')];

        const { result } = renderHook(() => useSpeechSynthesis());

        expect(result.current.selectedVoice?.name).toBe('Anna');
    });

    it('picks up voices delivered late via onvoiceschanged', () => {
        const { result } = renderHook(() => useSpeechSynthesis());
        expect(result.current.voices).toHaveLength(0);

        synth.voices = [makeVoice('Samantha', 'en-US')];
        act(() => synth.onvoiceschanged?.());

        expect(result.current.voices).toHaveLength(1);
        expect(result.current.selectedVoice?.name).toBe('Samantha');
    });

    it('speaks with the configured voice, rate, pitch and volume', () => {
        synth.voices = [makeVoice('Samantha', 'en-US')];
        const { result } = renderHook(() =>
            useSpeechSynthesis({ rate: 1.5, pitch: 0.8, volume: 0.25 })
        );

        act(() => result.current.speak('hello there'));

        const u = FakeUtterance.last;
        expect(u.text).toBe('hello there');
        expect(u.rate).toBe(1.5);
        expect(u.pitch).toBe(0.8);
        expect(u.volume).toBe(0.25);
        expect(u.voice?.name).toBe('Samantha');
        expect(synth.spoken).toHaveLength(1);
    });

    it('cancels any in-flight utterance before speaking a new one', () => {
        const { result } = renderHook(() => useSpeechSynthesis());

        act(() => result.current.speak('first'));
        act(() => result.current.speak('second'));

        expect(synth.cancelCount).toBeGreaterThanOrEqual(2);
        expect(synth.spoken.map((u) => u.text)).toEqual(['first', 'second']);
    });

    it('ignores empty text', () => {
        const { result } = renderHook(() => useSpeechSynthesis());

        act(() => result.current.speak(''));

        expect(synth.spoken).toHaveLength(0);
    });

    it('honours a caller-supplied voice over the auto-selected default', () => {
        synth.voices = [makeVoice('Samantha', 'en-US'), makeVoice('Daniel', 'en-GB')];
        const daniel = makeVoice('Daniel', 'en-GB');

        const { result } = renderHook(() => useSpeechSynthesis({ voice: daniel as any }));

        expect(result.current.selectedVoice?.name).toBe('Daniel');
    });

    it('setSelectedVoice changes which voice future utterances use', () => {
        synth.voices = [makeVoice('Samantha', 'en-US'), makeVoice('Daniel', 'en-GB')];
        const { result } = renderHook(() => useSpeechSynthesis());

        act(() => result.current.setSelectedVoice(synth.voices[1]));
        act(() => result.current.speak('test'));

        expect(FakeUtterance.last.voice?.name).toBe('Daniel');
    });

    it('fires onEnd and clears the speaking flag when the utterance finishes', () => {
        const onEnd = vi.fn();
        const { result } = renderHook(() => useSpeechSynthesis({ onEnd }));

        act(() => result.current.speak('hello'));
        act(() => {
            synth.speaking = false;
            FakeUtterance.last.onend?.();
        });

        expect(onEnd).toHaveBeenCalledTimes(1);
        expect(result.current.isSpeaking).toBe(false);
    });

    it('fires onError when the utterance errors', () => {
        const onError = vi.fn();
        const { result } = renderHook(() => useSpeechSynthesis({ onError }));

        act(() => result.current.speak('hello'));
        act(() => FakeUtterance.last.onerror?.({ error: 'synthesis-failed' }));

        expect(onError).toHaveBeenCalledWith('synthesis-failed');
        expect(result.current.isSpeaking).toBe(false);
    });

    it('reports a failure when speak() itself throws', () => {
        const onError = vi.fn();
        const { result } = renderHook(() => useSpeechSynthesis({ onError }));

        synth.speakError = new Error('not-allowed');
        act(() => result.current.speak('hello'));

        expect(onError).toHaveBeenCalledWith('Failed to start speech synthesis');
    });

    it('mirrors the engine speaking/paused flags via its poll', () => {
        vi.useFakeTimers();
        try {
            const { result } = renderHook(() => useSpeechSynthesis());

            act(() => {
                synth.speaking = true;
                vi.advanceTimersByTime(100);
            });
            expect(result.current.isSpeaking).toBe(true);

            act(() => {
                synth.paused = true;
                vi.advanceTimersByTime(100);
            });
            expect(result.current.isPaused).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('pauses only while actually speaking, and resumes from paused', () => {
        vi.useFakeTimers();
        try {
            const { result } = renderHook(() => useSpeechSynthesis());

            // Not speaking yet — pause is a no-op.
            act(() => result.current.pause());
            expect(synth.pauseCount).toBe(0);

            act(() => result.current.speak('hello'));
            act(() => {
                synth.speaking = true;
                vi.advanceTimersByTime(100);
            });

            act(() => result.current.pause());
            expect(synth.pauseCount).toBe(1);

            act(() => vi.advanceTimersByTime(100));
            act(() => result.current.resume());
            expect(synth.resumeCount).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancel() stops the engine and clears both flags', () => {
        const { result } = renderHook(() => useSpeechSynthesis());

        act(() => result.current.speak('hello'));
        const before = synth.cancelCount;
        act(() => result.current.cancel());

        expect(synth.cancelCount).toBe(before + 1);
        expect(result.current.isSpeaking).toBe(false);
        expect(result.current.isPaused).toBe(false);
    });

    it('clears its poll and cancels speech on unmount', () => {
        vi.useFakeTimers();
        try {
            const { result, unmount } = renderHook(() => useSpeechSynthesis());
            act(() => result.current.speak('hello'));

            const cancelsBefore = synth.cancelCount;
            unmount();

            expect(synth.cancelCount).toBe(cancelsBefore + 1);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

// ===========================================================================
// useElevenLabsTTS — fetch → Blob → Audio
// ===========================================================================

class FakeAudio {
    static instances: FakeAudio[] = [];
    /** Applied to the next constructed instance, so play() rejects. */
    static nextPlayError: Error | null = null;
    static get last(): FakeAudio {
        const a = FakeAudio.instances[FakeAudio.instances.length - 1];
        if (!a) throw new Error('no FakeAudio constructed');
        return a;
    }

    src: string;
    currentTime = 0;
    playCount = 0;
    pauseCount = 0;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    /** When set, play() rejects with it. */
    playError: Error | null = null;

    constructor(src: string) {
        this.src = src;
        this.playError = FakeAudio.nextPlayError;
        FakeAudio.nextPlayError = null;
        FakeAudio.instances.push(this);
    }

    async play() {
        if (this.playError) throw this.playError;
        this.playCount++;
    }
    pause() {
        this.pauseCount++;
    }
}

describe('useElevenLabsTTS', () => {
    let createdUrls: string[];
    let revokedUrls: string[];
    let originalFetch: typeof fetch;

    /** Resolves an audio response; `blob` is whatever the hook will wrap in Audio. */
    function okAudioResponse() {
        return {
            ok: true,
            status: 200,
            blob: async () => ({ type: 'audio/mpeg', size: 1234 }),
            json: async () => ({}),
        };
    }

    beforeEach(() => {
        FakeAudio.instances = [];
        createdUrls = [];
        revokedUrls = [];
        originalFetch = global.fetch;

        (global as any).Audio = FakeAudio;
        (global as any).URL.createObjectURL = vi.fn((_blob: any) => {
            const url = `blob:claudia/${createdUrls.length}`;
            createdUrls.push(url);
            return url;
        });
        (global as any).URL.revokeObjectURL = vi.fn((url: string) => {
            revokedUrls.push(url);
        });
    });

    afterEach(() => {
        cleanup();
        global.fetch = originalFetch;
        delete (global as any).Audio;
        delete (global as any).URL.createObjectURL;
        delete (global as any).URL.revokeObjectURL;
        vi.restoreAllMocks();
    });

    it('starts idle', () => {
        const { result } = renderHook(() => useElevenLabsTTS());

        expect(result.current.isSpeaking).toBe(false);
        expect(result.current.isLoading).toBe(false);
    });

    it('POSTs the text and default voice, then plays the returned audio', async () => {
        const fetchMock = vi.fn(async () => okAudioResponse());
        global.fetch = fetchMock as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('hello world');
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as any[];
        expect(url).toBe('http://claudia.test:9999/api/tts');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ text: 'hello world', voice: 'charlotte' });

        expect(FakeAudio.last.src).toBe(createdUrls[0]);
        expect(FakeAudio.last.playCount).toBe(1);
        expect(result.current.isSpeaking).toBe(true);
        expect(result.current.isLoading).toBe(false);
    });

    it('passes a caller-chosen voice through', async () => {
        const fetchMock = vi.fn(async () => okAudioResponse());
        global.fetch = fetchMock as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('hi', 'rachel');
        });

        expect(JSON.parse((fetchMock.mock.calls[0] as any[])[1].body).voice).toBe('rachel');
    });

    it('does nothing for blank text', async () => {
        const fetchMock = vi.fn(async () => okAudioResponse());
        global.fetch = fetchMock as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('   ');
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.current.isLoading).toBe(false);
    });

    it('releases the object URL and goes idle when playback ends', async () => {
        global.fetch = vi.fn(async () => okAudioResponse()) as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('hello');
        });

        act(() => FakeAudio.last.onended?.());

        expect(revokedUrls).toEqual([createdUrls[0]]);
        expect(result.current.isSpeaking).toBe(false);
    });

    it('releases the object URL and goes idle when playback errors', async () => {
        global.fetch = vi.fn(async () => okAudioResponse()) as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('hello');
        });

        act(() => FakeAudio.last.onerror?.());

        expect(revokedUrls).toEqual([createdUrls[0]]);
        expect(result.current.isSpeaking).toBe(false);
    });

    it('clears loading state when the server rejects the request', async () => {
        global.fetch = vi.fn(async () => ({
            ok: false,
            status: 500,
            json: async () => ({ error: 'quota exceeded' }),
            blob: async () => ({}),
        })) as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('hello');
        });

        expect(FakeAudio.instances).toHaveLength(0);
        expect(result.current.isSpeaking).toBe(false);
        expect(result.current.isLoading).toBe(false);
    });

    it('survives an error body that is not JSON', async () => {
        global.fetch = vi.fn(async () => ({
            ok: false,
            status: 502,
            json: async () => {
                throw new Error('not json');
            },
            blob: async () => ({}),
        })) as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('hello');
        });

        expect(result.current.isLoading).toBe(false);
        expect(result.current.isSpeaking).toBe(false);
    });

    it('clears state when the network call itself fails', async () => {
        global.fetch = vi.fn(async () => {
            throw new Error('ECONNREFUSED');
        }) as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('hello');
        });

        expect(result.current.isLoading).toBe(false);
        expect(result.current.isSpeaking).toBe(false);
    });

    it('clears state when audio playback is blocked by the browser', async () => {
        global.fetch = vi.fn(async () => okAudioResponse()) as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        FakeAudio.nextPlayError = new Error('NotAllowedError');
        await act(async () => {
            await result.current.speak('hello');
        });

        expect(result.current.isSpeaking).toBe(false);
        expect(result.current.isLoading).toBe(false);
        // BUG (reported, not fixed): the blob URL minted for this playback is
        // never revoked on the play() failure path — only onended/onerror
        // revoke it, and neither fires when play() itself rejects.
        expect(revokedUrls).toEqual([]);
    });

    it('cancel() aborts the in-flight request', async () => {
        let capturedSignal: AbortSignal | undefined;
        global.fetch = vi.fn(async (_url: any, init: any) => {
            capturedSignal = init.signal;
            return okAudioResponse();
        }) as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('hello');
        });

        expect(capturedSignal?.aborted).toBe(false);
        act(() => result.current.cancel());
        expect(capturedSignal?.aborted).toBe(true);
    });

    it('cancel() pauses and rewinds the playing audio', async () => {
        global.fetch = vi.fn(async () => okAudioResponse()) as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('hello');
        });
        const audio = FakeAudio.last;

        act(() => result.current.cancel());

        expect(audio.pauseCount).toBe(1);
        expect(audio.currentTime).toBe(0);
        expect(result.current.isSpeaking).toBe(false);
    });

    it('a second speak() cancels the first before starting', async () => {
        global.fetch = vi.fn(async () => okAudioResponse()) as any;

        const { result } = renderHook(() => useElevenLabsTTS());
        await act(async () => {
            await result.current.speak('first');
        });
        const firstAudio = FakeAudio.last;

        await act(async () => {
            await result.current.speak('second');
        });

        expect(firstAudio.pauseCount).toBe(1);
        expect(FakeAudio.instances).toHaveLength(2);
        expect(result.current.isSpeaking).toBe(true);
    });

    it('cancel() on an idle hook is harmless', () => {
        const { result } = renderHook(() => useElevenLabsTTS());

        expect(() => act(() => result.current.cancel())).not.toThrow();
        expect(result.current.isSpeaking).toBe(false);
    });
});

// ===========================================================================
// useDeepgramRecognition — getUserMedia + MediaRecorder + WebSocket
// ===========================================================================

class FakeTrack {
    label = 'Fake Mic';
    readyState = 'live';
    stopCount = 0;
    stop() {
        this.stopCount++;
        this.readyState = 'ended';
    }
}

class FakeMediaStream {
    active = true;
    tracks = [new FakeTrack()];
    getTracks() {
        return this.tracks;
    }
}

class FakeMediaRecorder {
    static instances: FakeMediaRecorder[] = [];
    static supportedTypes = new Set(['audio/webm;codecs=opus', 'audio/webm']);
    /** When set, the constructor throws it. */
    static constructError: Error | null = null;

    static isTypeSupported(t: string) {
        return FakeMediaRecorder.supportedTypes.has(t);
    }
    static reset() {
        FakeMediaRecorder.instances = [];
        FakeMediaRecorder.constructError = null;
        FakeMediaRecorder.supportedTypes = new Set(['audio/webm;codecs=opus', 'audio/webm']);
    }
    static get last(): FakeMediaRecorder {
        const r = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];
        if (!r) throw new Error('no FakeMediaRecorder constructed');
        return r;
    }

    state: 'inactive' | 'recording' = 'inactive';
    stream: any;
    mimeType: string;
    timeslice: number | null = null;
    stopCount = 0;
    ondataavailable: ((e: any) => void) | null = null;
    onerror: ((e: any) => void) | null = null;

    constructor(stream: any, opts: any = {}) {
        if (FakeMediaRecorder.constructError) throw FakeMediaRecorder.constructError;
        this.stream = stream;
        this.mimeType = opts.mimeType ?? '';
        FakeMediaRecorder.instances.push(this);
    }

    start(timeslice?: number) {
        this.timeslice = timeslice ?? null;
        this.state = 'recording';
    }
    stop() {
        this.stopCount++;
        this.state = 'inactive';
    }

    /** Deliver an audio chunk as the browser would. */
    emitChunk(size = 512) {
        this.ondataavailable?.({ data: { size } });
    }
}

class FakeDeepgramSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    static instances: FakeDeepgramSocket[] = [];
    static reset() {
        FakeDeepgramSocket.instances = [];
    }
    static get last(): FakeDeepgramSocket {
        const ws = FakeDeepgramSocket.instances[FakeDeepgramSocket.instances.length - 1];
        if (!ws) throw new Error('no FakeDeepgramSocket constructed');
        return ws;
    }

    readyState = FakeDeepgramSocket.CONNECTING;
    url: string;
    protocols: string | string[] | undefined;
    sent: any[] = [];
    closeCount = 0;

    onopen: ((e: Event) => void) | null = null;
    onclose: ((e: any) => void) | null = null;
    onmessage: ((e: any) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;

    constructor(url: string, protocols?: string | string[]) {
        this.url = url;
        this.protocols = protocols;
        FakeDeepgramSocket.instances.push(this);
    }

    send(data: any) {
        this.sent.push(data);
    }
    close() {
        this.closeCount++;
        this.readyState = FakeDeepgramSocket.CLOSED;
    }
    addEventListener() {}
    removeEventListener() {}

    // --- test drivers ------------------------------------------------------

    simulateOpen() {
        this.readyState = FakeDeepgramSocket.OPEN;
        this.onopen?.(new Event('open'));
    }
    simulateClose(code = 1006) {
        this.readyState = FakeDeepgramSocket.CLOSED;
        this.onclose?.({ code, reason: '' });
    }
    simulateError() {
        this.onerror?.(new Event('error'));
    }
    simulateJson(payload: unknown) {
        this.onmessage?.({ data: JSON.stringify(payload) });
    }
    simulateRaw(data: string) {
        this.onmessage?.({ data });
    }
}

/** Build a Deepgram "Results" frame. */
function dgResult(transcript: string, isFinal: boolean) {
    return {
        type: 'Results',
        is_final: isFinal,
        speech_final: isFinal,
        channel: { alternatives: [{ transcript }] },
    };
}

const API_KEY = 'dg-test-key';

describe('useDeepgramRecognition', () => {
    let originalWebSocket: typeof WebSocket;
    let getUserMedia: ReturnType<typeof vi.fn>;
    let stream: FakeMediaStream;

    beforeEach(() => {
        FakeDeepgramSocket.reset();
        FakeMediaRecorder.reset();
        originalWebSocket = global.WebSocket;
        (global as any).WebSocket = FakeDeepgramSocket;
        (global as any).MediaRecorder = FakeMediaRecorder;

        stream = new FakeMediaStream();
        getUserMedia = vi.fn(async () => stream);
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: { getUserMedia },
        });
    });

    afterEach(() => {
        cleanup();
        global.WebSocket = originalWebSocket;
        delete (global as any).MediaRecorder;
        // @ts-expect-error – removing the property we installed
        delete navigator.mediaDevices;
        vi.restoreAllMocks();
    });

    /** Mount, start, and bring the socket up so a recorder exists. */
    async function startListening(options: Record<string, unknown> = {}) {
        const hook = renderHook(() =>
            useDeepgramRecognition({ deepgramApiKey: API_KEY, ...options })
        );
        await act(async () => {
            await hook.result.current.startListening();
        });
        act(() => FakeDeepgramSocket.last.simulateOpen());
        return hook;
    }

    it('reports unsupported when getUserMedia is unavailable', () => {
        Object.defineProperty(navigator, 'mediaDevices', {
            configurable: true,
            value: undefined,
        });

        const { result } = renderHook(() => useDeepgramRecognition({ deepgramApiKey: API_KEY }));

        expect(result.current.isSupported).toBe(false);
    });

    it('reports supported when getUserMedia exists', () => {
        const { result } = renderHook(() => useDeepgramRecognition({ deepgramApiKey: API_KEY }));

        expect(result.current.isSupported).toBe(true);
    });

    it('refuses to start without an API key and never touches the mic', async () => {
        const onError = vi.fn();
        const { result } = renderHook(() => useDeepgramRecognition({ onError }));

        await act(async () => {
            await result.current.startListening();
        });

        expect(onError).toHaveBeenCalledWith(
            'Deepgram API key not configured. Set it in Voice Settings.'
        );
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(FakeDeepgramSocket.instances).toHaveLength(0);
        expect(result.current.isListening).toBe(false);
    });

    it('opens a Deepgram socket authenticated with the token protocol', async () => {
        await startListening({ language: 'es' });

        const ws = FakeDeepgramSocket.last;
        expect(ws.url).toContain('wss://api.deepgram.com/v1/listen');
        expect(ws.url).toContain('model=nova-3');
        expect(ws.url).toContain('language=es');
        expect(ws.protocols).toEqual(['token', API_KEY]);
    });

    it('negotiates the opus encoding the browser reports as supported', async () => {
        await startListening();

        expect(FakeDeepgramSocket.last.url).toContain('encoding=opus');
        expect(FakeMediaRecorder.last.mimeType).toBe('audio/webm;codecs=opus');
    });

    it('falls back to mp4 encoding on Safari-style browsers', async () => {
        FakeMediaRecorder.supportedTypes = new Set(['audio/mp4']);

        await startListening();

        expect(FakeDeepgramSocket.last.url).toContain('encoding=mp4');
        expect(FakeMediaRecorder.last.mimeType).toBe('audio/mp4');
    });

    it('falls back to linear16 with no mimeType when nothing is supported', async () => {
        FakeMediaRecorder.supportedTypes = new Set();

        await startListening();

        expect(FakeDeepgramSocket.last.url).toContain('encoding=linear16');
        expect(FakeMediaRecorder.last.mimeType).toBe('');
    });

    it('starts chunked recording and reports listening once the socket opens', async () => {
        const onListeningChange = vi.fn();
        const { result } = await startListening({ onListeningChange });

        expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
        expect(FakeMediaRecorder.last.state).toBe('recording');
        expect(FakeMediaRecorder.last.timeslice).toBe(250);
        expect(result.current.isListening).toBe(true);
        expect(onListeningChange).toHaveBeenLastCalledWith(true);
    });

    it('streams audio chunks to the socket while it is open', async () => {
        await startListening();

        act(() => FakeMediaRecorder.last.emitChunk(1024));

        expect(FakeDeepgramSocket.last.sent).toHaveLength(1);
        expect(FakeDeepgramSocket.last.sent[0]).toEqual({ size: 1024 });
    });

    it('drops empty chunks instead of sending them', async () => {
        await startListening();

        act(() => FakeMediaRecorder.last.emitChunk(0));

        expect(FakeDeepgramSocket.last.sent).toHaveLength(0);
    });

    it('does not send chunks after the socket closed', async () => {
        await startListening();
        const ws = FakeDeepgramSocket.last;
        const recorder = FakeMediaRecorder.last;

        ws.readyState = FakeDeepgramSocket.CLOSED;
        act(() => recorder.emitChunk(1024));

        expect(ws.sent).toHaveLength(0);
    });

    it('ignores a second startListening while already listening', async () => {
        const { result } = await startListening();

        await act(async () => {
            await result.current.startListening();
        });

        expect(getUserMedia).toHaveBeenCalledTimes(1);
        expect(FakeDeepgramSocket.instances).toHaveLength(1);
    });

    describe('transcripts', () => {
        it('surfaces interim results without committing them', async () => {
            const onResult = vi.fn();
            const { result } = await startListening({ onResult });

            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('hello wor', false)));

            expect(result.current.interimTranscript).toBe('hello wor');
            expect(result.current.transcript).toBe('');
            expect(onResult).toHaveBeenCalledWith('hello wor', false);
        });

        it('commits a final result and clears the interim buffer', async () => {
            const onResult = vi.fn();
            const { result } = await startListening({ onResult });

            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('interim', false)));
            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('hello world', true)));

            expect(result.current.transcript).toBe('hello world');
            expect(result.current.interimTranscript).toBe('');
            expect(onResult).toHaveBeenLastCalledWith('hello world', true);
        });

        it('space-joins accumulated finals in continuous mode', async () => {
            const { result } = await startListening({ continuous: true });

            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('hello', true)));
            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('world', true)));

            expect(result.current.transcript).toBe('hello world');
        });

        it('replaces finals in one-shot mode', async () => {
            const { result } = await startListening({ continuous: false });

            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('hello', true)));
            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('world', true)));

            expect(result.current.transcript).toBe('world');
        });

        it('suppresses interim results when interimResults is off', async () => {
            const onResult = vi.fn();
            const { result } = await startListening({ interimResults: false });

            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('partial', false)));

            expect(result.current.interimTranscript).toBe('');
            expect(onResult).not.toHaveBeenCalled();
        });

        it('ignores empty transcripts and frames with no alternatives', async () => {
            const onResult = vi.fn();
            const { result } = await startListening();

            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('', true)));
            act(() =>
                FakeDeepgramSocket.last.simulateJson({
                    type: 'Results',
                    is_final: true,
                    channel: { alternatives: [] },
                })
            );

            expect(onResult).not.toHaveBeenCalled();
            expect(result.current.transcript).toBe('');
        });

        it('ignores Metadata frames', async () => {
            const onResult = vi.fn();
            await startListening({ onResult });

            act(() =>
                FakeDeepgramSocket.last.simulateJson({ type: 'Metadata', request_id: 'abc' })
            );

            expect(onResult).not.toHaveBeenCalled();
        });

        it('survives a malformed frame without tearing down the session', async () => {
            const onResult = vi.fn();
            const { result } = await startListening({ onResult });

            act(() => FakeDeepgramSocket.last.simulateRaw('<<not json>>'));

            expect(result.current.isListening).toBe(true);
            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('still working', true)));
            expect(onResult).toHaveBeenCalledWith('still working', true);
        });

        it('resetTranscript clears buffers and the accumulator', async () => {
            const { result } = await startListening({ continuous: true });

            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('hello', true)));
            act(() => result.current.resetTranscript());

            expect(result.current.transcript).toBe('');

            act(() => FakeDeepgramSocket.last.simulateJson(dgResult('world', true)));
            expect(result.current.transcript).toBe('world');
        });
    });

    describe('error handling', () => {
        it('reports a denied microphone permission', async () => {
            const onError = vi.fn();
            const denied = new Error('denied');
            denied.name = 'NotAllowedError';
            getUserMedia.mockRejectedValueOnce(denied);

            const { result } = renderHook(() =>
                useDeepgramRecognition({ deepgramApiKey: API_KEY, onError })
            );
            await act(async () => {
                await result.current.startListening();
            });

            expect(onError).toHaveBeenCalledWith(
                'Microphone access denied. Please allow microphone access.'
            );
            expect(result.current.isListening).toBe(false);
            expect(FakeDeepgramSocket.instances).toHaveLength(0);
        });

        it('reports a missing microphone', async () => {
            const onError = vi.fn();
            const missing = new Error('none');
            missing.name = 'NotFoundError';
            getUserMedia.mockRejectedValueOnce(missing);

            const { result } = renderHook(() =>
                useDeepgramRecognition({ deepgramApiKey: API_KEY, onError })
            );
            await act(async () => {
                await result.current.startListening();
            });

            expect(onError).toHaveBeenCalledWith('No microphone found.');
        });

        it('reports any other mic failure with its message', async () => {
            const onError = vi.fn();
            getUserMedia.mockRejectedValueOnce(new Error('device busy'));

            const { result } = renderHook(() =>
                useDeepgramRecognition({ deepgramApiKey: API_KEY, onError })
            );
            await act(async () => {
                await result.current.startListening();
            });

            expect(onError).toHaveBeenCalledWith(
                'Failed to start voice recognition: device busy'
            );
        });

        it('lets a retry succeed after a failed start', async () => {
            getUserMedia.mockRejectedValueOnce(new Error('device busy'));
            const { result } = renderHook(() =>
                useDeepgramRecognition({ deepgramApiKey: API_KEY })
            );

            await act(async () => {
                await result.current.startListening();
            });
            await act(async () => {
                await result.current.startListening();
            });
            act(() => FakeDeepgramSocket.last.simulateOpen());

            expect(result.current.isListening).toBe(true);
        });

        it('reports a socket error', async () => {
            const onError = vi.fn();
            await startListening({ onError });

            act(() => FakeDeepgramSocket.last.simulateError());

            expect(onError).toHaveBeenCalledWith('Connection error to Deepgram');
        });

        it('surfaces a Deepgram Error frame description', async () => {
            const onError = vi.fn();
            await startListening({ onError });

            act(() =>
                FakeDeepgramSocket.last.simulateJson({
                    type: 'Error',
                    description: 'invalid credentials',
                })
            );

            expect(onError).toHaveBeenCalledWith('invalid credentials');
        });

        it('falls back to a generic message for a description-less Error frame', async () => {
            const onError = vi.fn();
            await startListening({ onError });

            act(() => FakeDeepgramSocket.last.simulateJson({ type: 'Error' }));

            expect(onError).toHaveBeenCalledWith('Deepgram transcription error');
        });

        it('reports a MediaRecorder failure and releases the mic', async () => {
            const onError = vi.fn();
            const hook = renderHook(() =>
                useDeepgramRecognition({ deepgramApiKey: API_KEY, onError })
            );
            await act(async () => {
                await hook.result.current.startListening();
            });

            FakeMediaRecorder.constructError = new Error('unsupported mimeType');
            act(() => FakeDeepgramSocket.last.simulateOpen());

            expect(onError).toHaveBeenCalledWith('Failed to start audio recording');
            expect(hook.result.current.isListening).toBe(false);
            expect(stream.tracks[0].stopCount).toBe(1);
        });

        it('reports a recorder runtime error', async () => {
            const onError = vi.fn();
            await startListening({ onError });

            act(() => FakeMediaRecorder.last.onerror?.({ type: 'error' }));

            expect(onError).toHaveBeenCalledWith('Microphone recording error');
        });
    });

    describe('teardown', () => {
        it('stopListening flushes, closes the socket and releases the mic', async () => {
            const onListeningChange = vi.fn();
            const { result } = await startListening({ onListeningChange });
            const ws = FakeDeepgramSocket.last;
            const recorder = FakeMediaRecorder.last;

            act(() => result.current.stopListening());

            expect(recorder.stopCount).toBe(1);
            // Zero-length frame is Deepgram's end-of-audio marker.
            expect(ws.sent.at(-1)).toBeInstanceOf(Uint8Array);
            expect((ws.sent.at(-1) as Uint8Array).length).toBe(0);
            expect(ws.closeCount).toBe(1);
            expect(stream.tracks[0].stopCount).toBe(1);
            expect(result.current.isListening).toBe(false);
            expect(onListeningChange).toHaveBeenLastCalledWith(false);
        });

        it('does not reconnect after an explicit stop, even in continuous mode', async () => {
            vi.useFakeTimers();
            try {
                const hook = renderHook(() =>
                    useDeepgramRecognition({ deepgramApiKey: API_KEY, continuous: true })
                );
                await act(async () => {
                    await hook.result.current.startListening();
                });
                act(() => FakeDeepgramSocket.last.simulateOpen());

                act(() => hook.result.current.stopListening());
                act(() => FakeDeepgramSocket.last.simulateClose(1000));
                act(() => vi.advanceTimersByTime(5000));

                expect(FakeDeepgramSocket.instances).toHaveLength(1);
                expect(hook.result.current.isListening).toBe(false);
            } finally {
                vi.useRealTimers();
            }
        });

        it('goes idle when the socket drops in one-shot mode', async () => {
            const onListeningChange = vi.fn();
            const { result } = await startListening({ continuous: false, onListeningChange });

            act(() => FakeDeepgramSocket.last.simulateClose());

            expect(result.current.isListening).toBe(false);
            expect(onListeningChange).toHaveBeenLastCalledWith(false);
        });

        it('stopListening is idempotent', async () => {
            const { result } = await startListening();

            act(() => result.current.stopListening());
            expect(() => act(() => result.current.stopListening())).not.toThrow();
            expect(stream.tracks[0].stopCount).toBe(1);
        });

        it('releases everything on unmount and leaves no timers armed', async () => {
            vi.useFakeTimers();
            try {
                const hook = renderHook(() =>
                    useDeepgramRecognition({ deepgramApiKey: API_KEY, continuous: true })
                );
                await act(async () => {
                    await hook.result.current.startListening();
                });
                act(() => FakeDeepgramSocket.last.simulateOpen());
                const ws = FakeDeepgramSocket.last;

                hook.unmount();

                expect(ws.closeCount).toBe(1);
                expect(stream.tracks[0].stopCount).toBe(1);
                expect(vi.getTimerCount()).toBe(0);

                // A late close event must not spawn a reconnect.
                act(() => ws.simulateClose());
                act(() => vi.advanceTimersByTime(5000));
                expect(FakeDeepgramSocket.instances).toHaveLength(1);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('continuous-mode reconnect', () => {
        it('reopens the socket 500ms after an unexpected drop, reusing the mic stream', async () => {
            vi.useFakeTimers();
            try {
                const hook = renderHook(() =>
                    useDeepgramRecognition({ deepgramApiKey: API_KEY, continuous: true })
                );
                await act(async () => {
                    await hook.result.current.startListening();
                });
                act(() => FakeDeepgramSocket.last.simulateOpen());

                act(() => FakeDeepgramSocket.last.simulateClose(1006));
                expect(FakeDeepgramSocket.instances).toHaveLength(1);

                act(() => vi.advanceTimersByTime(500));

                expect(FakeDeepgramSocket.instances).toHaveLength(2);
                // Mic was never re-requested — the stream is reused.
                expect(getUserMedia).toHaveBeenCalledTimes(1);
                expect(stream.tracks[0].stopCount).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });

        it('restarts recording and keeps transcribing after a reconnect', async () => {
            vi.useFakeTimers();
            try {
                const onResult = vi.fn();
                const hook = renderHook(() =>
                    useDeepgramRecognition({
                        deepgramApiKey: API_KEY,
                        continuous: true,
                        onResult,
                    })
                );
                await act(async () => {
                    await hook.result.current.startListening();
                });
                act(() => FakeDeepgramSocket.last.simulateOpen());

                act(() => FakeDeepgramSocket.last.simulateClose(1006));
                act(() => vi.advanceTimersByTime(500));
                act(() => FakeDeepgramSocket.last.simulateOpen());

                expect(FakeMediaRecorder.last.state).toBe('recording');
                expect(FakeMediaRecorder.last.timeslice).toBe(250);

                act(() => FakeDeepgramSocket.last.simulateJson(dgResult('after reconnect', true)));
                expect(onResult).toHaveBeenLastCalledWith('after reconnect', true);
                expect(hook.result.current.transcript).toBe('after reconnect');
            } finally {
                vi.useRealTimers();
            }
        });

        it('gives up when the mic stream died', async () => {
            vi.useFakeTimers();
            try {
                const onListeningChange = vi.fn();
                const hook = renderHook(() =>
                    useDeepgramRecognition({
                        deepgramApiKey: API_KEY,
                        continuous: true,
                        onListeningChange,
                    })
                );
                await act(async () => {
                    await hook.result.current.startListening();
                });
                act(() => FakeDeepgramSocket.last.simulateOpen());

                stream.active = false;
                act(() => FakeDeepgramSocket.last.simulateClose(1006));

                expect(hook.result.current.isListening).toBe(false);
                expect(onListeningChange).toHaveBeenLastCalledWith(false);

                act(() => vi.advanceTimersByTime(5000));
                expect(FakeDeepgramSocket.instances).toHaveLength(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it('backs off to 1s for a second consecutive drop', async () => {
            vi.useFakeTimers();
            try {
                const hook = renderHook(() =>
                    useDeepgramRecognition({ deepgramApiKey: API_KEY, continuous: true })
                );
                await act(async () => {
                    await hook.result.current.startListening();
                });
                act(() => FakeDeepgramSocket.last.simulateOpen());

                act(() => FakeDeepgramSocket.last.simulateClose(1006));
                act(() => vi.advanceTimersByTime(500));
                act(() => FakeDeepgramSocket.last.simulateOpen());

                // Second drop comes from the reconnect path, which waits 1s.
                act(() => FakeDeepgramSocket.last.simulateClose(1006));
                act(() => vi.advanceTimersByTime(999));
                expect(FakeDeepgramSocket.instances).toHaveLength(2);

                act(() => vi.advanceTimersByTime(1));
                expect(FakeDeepgramSocket.instances).toHaveLength(3);
            } finally {
                vi.useRealTimers();
            }
        });

        it('closes a socket that opens after the user already stopped', async () => {
            const hook = renderHook(() =>
                useDeepgramRecognition({ deepgramApiKey: API_KEY, continuous: true })
            );
            await act(async () => {
                await hook.result.current.startListening();
            });
            const ws = FakeDeepgramSocket.last;

            act(() => hook.result.current.stopListening());
            act(() => ws.simulateOpen());

            // Never started recording; socket closed instead.
            expect(FakeMediaRecorder.instances).toHaveLength(0);
            expect(ws.closeCount).toBeGreaterThanOrEqual(1);
        });

        it('releases a mic granted after the user already stopped', async () => {
            let releaseMic: (s: FakeMediaStream) => void = () => {};
            getUserMedia.mockImplementationOnce(
                () => new Promise<FakeMediaStream>((resolve) => (releaseMic = resolve))
            );

            const hook = renderHook(() =>
                useDeepgramRecognition({ deepgramApiKey: API_KEY })
            );

            let startPromise: Promise<void>;
            act(() => {
                startPromise = hook.result.current.startListening();
            });
            act(() => hook.result.current.stopListening());

            await act(async () => {
                releaseMic(stream);
                await startPromise!;
            });

            expect(stream.tracks[0].stopCount).toBe(1);
            expect(FakeDeepgramSocket.instances).toHaveLength(0);
            expect(hook.result.current.isListening).toBe(false);
        });
    });

    it('rebuilds nothing and keeps listening when only callbacks change identity', async () => {
        const { rerender, result } = renderHook(
            ({ cb }: { cb: (transcript: string, isFinal: boolean) => void }) =>
                useDeepgramRecognition({ deepgramApiKey: API_KEY, onResult: cb }),
            { initialProps: { cb: vi.fn() } }
        );

        await act(async () => {
            await result.current.startListening();
        });
        act(() => FakeDeepgramSocket.last.simulateOpen());

        const second = vi.fn();
        rerender({ cb: second });

        expect(FakeDeepgramSocket.instances).toHaveLength(1);
        act(() => FakeDeepgramSocket.last.simulateJson(dgResult('routed', true)));
        await waitFor(() => expect(second).toHaveBeenCalledWith('routed', true));
    });
});
