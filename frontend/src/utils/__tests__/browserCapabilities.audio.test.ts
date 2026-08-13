/**
 * Companion suite for browserCapabilities — the audio half, which the original
 * suite skips entirely because jsdom has no Web Audio.
 *
 * The module caches its AudioContext and generated WAV in module-level
 * singletons, so every test loads a FRESH copy via resetModules + dynamic
 * import. Without that, the first test's context state leaks into all the rest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type AudioModule = typeof import('../browserCapabilities');

/** Records the oscillator/gain graph the chime builds. */
interface AudioSpy {
    ctx: FakeAudioContext;
    oscillators: FakeOscillator[];
    gains: FakeGain[];
    resumeCalls: number;
}

class FakeParam {
    setValueAtTime = vi.fn();
    exponentialRampToValueAtTime = vi.fn();
}

class FakeGain {
    gain = new FakeParam();
    connect = vi.fn();
}

class FakeOscillator {
    type = '';
    frequency = new FakeParam();
    connect = vi.fn();
    start = vi.fn();
    stop = vi.fn();
}

class FakeAudioContext {
    static spy: AudioSpy;
    currentTime = 0;
    destination = {} as AudioDestinationNode;
    state: AudioContextState;

    constructor(state: AudioContextState = 'running') {
        this.state = state;
    }

    createGain() {
        const g = new FakeGain();
        FakeAudioContext.spy.gains.push(g);
        return g as unknown as GainNode;
    }

    createOscillator() {
        const o = new FakeOscillator();
        FakeAudioContext.spy.oscillators.push(o);
        return o as unknown as OscillatorNode;
    }

    resume() {
        FakeAudioContext.spy.resumeCalls++;
        // Real resume() is asynchronous: the state is still 'suspended' when it
        // returns. That is exactly why the code falls back to HTML Audio here
        // instead of trusting Web Audio, so the fake must not flip early.
        return Promise.resolve().then(() => {
            this.state = 'running';
        });
    }
}

/**
 * Install a fake AudioContext in the given state and return a fresh copy of the
 * module plus a spy on the audio graph it builds.
 */
async function loadWithAudio(
    state: AudioContextState | null,
): Promise<{ mod: AudioModule; spy: AudioSpy }> {
    const spy: AudioSpy = { ctx: null as unknown as FakeAudioContext, oscillators: [], gains: [], resumeCalls: 0 };
    FakeAudioContext.spy = spy;

    if (state === null) {
        // Browser with no Web Audio at all.
        Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true, writable: true });
        Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true, writable: true });
    } else {
        const Ctor = function AudioContextCtor(this: unknown) {
            const instance = new FakeAudioContext(state);
            spy.ctx = instance;
            return instance;
        } as unknown as typeof AudioContext;
        Object.defineProperty(window, 'AudioContext', { value: Ctor, configurable: true, writable: true });
        Object.defineProperty(window, 'webkitAudioContext', { value: Ctor, configurable: true, writable: true });
    }

    vi.resetModules();
    const mod = (await import('../browserCapabilities')) as AudioModule;
    return { mod, spy };
}

let playedAudioUrls: string[];
let audioPlayResult: () => Promise<void>;

beforeEach(() => {
    localStorage.clear();
    playedAudioUrls = [];
    audioPlayResult = () => Promise.resolve();

    // HTML Audio fallback + Blob URL plumbing that jsdom lacks.
    Object.defineProperty(window, 'Audio', {
        configurable: true,
        writable: true,
        value: class FakeAudio {
            constructor(public src: string) {
                playedAudioUrls.push(src);
            }
            play() {
                return audioPlayResult();
            }
        },
    });
    if (!URL.createObjectURL) {
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: () => '' });
    }
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:chime');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('playTaskCompletionSound — Web Audio path', () => {
    it('builds the three-tone C5→E5→G5 chime when the context is running', async () => {
        const { mod, spy } = await loadWithAudio('running');

        mod.playTaskCompletionSound();

        expect(spy.oscillators).toHaveLength(3);
        expect(spy.gains).toHaveLength(3);
        // Each tone connects to its own gain, and each gain to the destination.
        for (const osc of spy.oscillators) {
            expect(osc.type).toBe('sine');
            expect(osc.start).toHaveBeenCalledTimes(1);
            expect(osc.stop).toHaveBeenCalledTimes(1);
            expect(osc.connect).toHaveBeenCalledTimes(1);
        }
        const frequencies = spy.oscillators.map((o) => o.frequency.setValueAtTime.mock.calls[0][0]);
        expect(frequencies).toEqual([523, 659, 784]);
        // No HTML Audio fallback needed.
        expect(playedAudioUrls).toEqual([]);
    });

    it('reuses one AudioContext across repeated chimes', async () => {
        const { mod, spy } = await loadWithAudio('running');

        mod.playTaskCompletionSound();
        mod.playTaskCompletionSound();

        // Six oscillators from a single cached context.
        expect(spy.oscillators).toHaveLength(6);
    });

    it('stays silent when the user has turned the sound off', async () => {
        localStorage.setItem('claudia-completion-sound', 'false');
        const { mod, spy } = await loadWithAudio('running');

        mod.playTaskCompletionSound();

        expect(spy.oscillators).toHaveLength(0);
    });

    it('playTestSound chimes even while the sound setting is off, and restores it', async () => {
        localStorage.setItem('claudia-completion-sound', 'false');
        const { mod, spy } = await loadWithAudio('running');

        mod.playTestSound();
        expect(spy.oscillators).toHaveLength(3);

        // The override must be temporary.
        mod.playTaskCompletionSound();
        expect(spy.oscillators).toHaveLength(3);
        expect(mod.isSoundEnabled()).toBe(false);
    });

    it('setSoundEnabled round-trips through localStorage', async () => {
        const { mod } = await loadWithAudio('running');

        expect(mod.isSoundEnabled()).toBe(true);
        mod.setSoundEnabled(false);
        expect(mod.isSoundEnabled()).toBe(false);
        expect(localStorage.getItem('claudia-completion-sound')).toBe('false');

        mod.setSoundEnabled(true);
        expect(mod.isSoundEnabled()).toBe(true);
    });
});

describe('playTaskCompletionSound — HTML Audio fallback', () => {
    it('falls back to a generated WAV when the context is suspended (iOS background)', async () => {
        const { mod, spy } = await loadWithAudio('suspended');

        mod.playTaskCompletionSound();

        // getOrCreateAudioContext resumes a suspended context, and the chime
        // goes out over HTML Audio because Web Audio cannot be trusted here.
        expect(spy.resumeCalls).toBeGreaterThan(0);
        expect(playedAudioUrls).toEqual(['blob:chime']);
    });

    it('generates the WAV once and reuses the blob URL', async () => {
        const { mod } = await loadWithAudio('suspended');

        mod.playTaskCompletionSound();
        mod.playTaskCompletionSound();

        expect(playedAudioUrls).toEqual(['blob:chime', 'blob:chime']);
        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('uses HTML Audio when the browser has no Web Audio at all', async () => {
        const { mod } = await loadWithAudio(null);

        mod.playTaskCompletionSound();

        expect(playedAudioUrls).toEqual(['blob:chime']);
    });

    it('swallows a rejected play() — autoplay policy must not break the app', async () => {
        audioPlayResult = () => Promise.reject(new Error('autoplay blocked'));
        const { mod } = await loadWithAudio('suspended');

        expect(() => mod.playTaskCompletionSound()).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();

        expect(console.warn).toHaveBeenCalledWith(
            '[Sound] HTML Audio fallback failed:',
            'autoplay blocked',
        );
    });

    it('swallows a throwing Audio constructor', async () => {
        Object.defineProperty(window, 'Audio', {
            configurable: true,
            writable: true,
            value: class {
                constructor() {
                    throw new Error('no audio element');
                }
            },
        });
        const { mod } = await loadWithAudio('suspended');

        expect(() => mod.playTaskCompletionSound()).not.toThrow();
        expect(console.warn).toHaveBeenCalledWith('[Sound] HTML Audio fallback error:', expect.anything());
    });

    it('gives up quietly when the WAV cannot be generated', async () => {
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
            throw new Error('no blob support');
        });
        const { mod } = await loadWithAudio('suspended');

        expect(() => mod.playTaskCompletionSound()).not.toThrow();
        expect(playedAudioUrls).toEqual([]);
        expect(console.warn).toHaveBeenCalledWith('[Sound] Failed to generate chime WAV:', expect.anything());
    });
});

describe('setupAudioUnlock', () => {
    it('resumes a suspended context on the first click or touch', async () => {
        const { mod, spy } = await loadWithAudio('suspended');

        mod.setupAudioUnlock();
        document.dispatchEvent(new Event('click'));

        expect(spy.resumeCalls).toBeGreaterThan(0);
    });

    it('keeps listening after the first interaction (iOS can re-suspend)', async () => {
        const { mod, spy } = await loadWithAudio('suspended');
        mod.setupAudioUnlock();

        document.dispatchEvent(new Event('click'));
        const afterFirst = spy.resumeCalls;
        // Simulate the OS suspending us again while backgrounded.
        spy.ctx.state = 'suspended';
        document.dispatchEvent(new Event('touchstart'));

        expect(spy.resumeCalls).toBeGreaterThan(afterFirst);
    });

    it('is a no-op in a browser with no Web Audio', async () => {
        const { mod } = await loadWithAudio(null);

        mod.setupAudioUnlock();
        expect(() => document.dispatchEvent(new Event('click'))).not.toThrow();
    });
});
