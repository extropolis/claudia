import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    isElectron,
    hasFileSystemAccess,
    getDirectorySelectionMethod,
    hasClipboardAPI,
    getUnsupportedFeatureMessage,
    getBrowserCapabilities,
    hasBrowserNotifications,
    getNotificationPermission,
    requestNotificationPermission,
    sendBrowserNotification,
    sendTaskCompletionNotification,
    sendTaskWaitingInputNotification,
    isSoundEnabled,
    setSoundEnabled,
    setupAudioUnlock,
    playTaskCompletionSound,
    playTestSound,
} from '../browserCapabilities';

// Helpers to set / clear globals safely
function setWindowProp(prop: string, value: unknown) {
    Object.defineProperty(window, prop, { value, configurable: true, writable: true });
}
function deleteWindowProp(prop: string) {
    // delete works because we defined props as configurable
    delete (window as any)[prop];
}

describe('browserCapabilities', () => {
    beforeEach(() => {
        deleteWindowProp('electronAPI');
        deleteWindowProp('showDirectoryPicker');
        localStorage.clear();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        deleteWindowProp('electronAPI');
        deleteWindowProp('showDirectoryPicker');
        deleteWindowProp('Notification');
        vi.restoreAllMocks();
    });

    describe('isElectron', () => {
        it('returns false when electronAPI is undefined', () => {
            expect(isElectron()).toBe(false);
        });

        it('returns true when electronAPI is defined', () => {
            setWindowProp('electronAPI', { getBackendUrl: () => 'x' });
            expect(isElectron()).toBe(true);
        });
    });

    describe('hasFileSystemAccess', () => {
        it('returns false when showDirectoryPicker is absent', () => {
            expect(hasFileSystemAccess()).toBe(false);
        });

        it('returns true when showDirectoryPicker is a function', () => {
            setWindowProp('showDirectoryPicker', () => {});
            expect(hasFileSystemAccess()).toBe(true);
        });

        it('returns false when showDirectoryPicker exists but is not a function', () => {
            setWindowProp('showDirectoryPicker', 'not-a-fn');
            expect(hasFileSystemAccess()).toBe(false);
        });
    });

    describe('getDirectorySelectionMethod', () => {
        it('returns electron when in electron', () => {
            setWindowProp('electronAPI', {});
            expect(getDirectorySelectionMethod()).toBe('electron');
        });

        it('returns filesystem-api when FS access available (no electron)', () => {
            setWindowProp('showDirectoryPicker', () => {});
            expect(getDirectorySelectionMethod()).toBe('filesystem-api');
        });

        it('returns none when nothing available', () => {
            expect(getDirectorySelectionMethod()).toBe('none');
        });
    });

    describe('hasClipboardAPI', () => {
        it('returns true when clipboard.writeText is a function (jsdom default may vary)', () => {
            const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText: () => Promise.resolve() },
                configurable: true,
            });
            expect(hasClipboardAPI()).toBe(true);
            if (orig) Object.defineProperty(navigator, 'clipboard', orig);
            else delete (navigator as any).clipboard;
        });

        it('returns false when clipboard is undefined', () => {
            const orig = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
            Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
            expect(hasClipboardAPI()).toBe(false);
            if (orig) Object.defineProperty(navigator, 'clipboard', orig);
            else delete (navigator as any).clipboard;
        });
    });

    describe('getUnsupportedFeatureMessage', () => {
        it('returns specific message for directory-picker', () => {
            expect(getUnsupportedFeatureMessage('directory-picker')).toContain('Directory selection');
        });

        it('returns specific message for clipboard', () => {
            expect(getUnsupportedFeatureMessage('clipboard')).toContain('Clipboard access');
        });

        it('returns generic message for unknown feature', () => {
            expect(getUnsupportedFeatureMessage('foo')).toContain('foo');
        });
    });

    describe('getBrowserCapabilities', () => {
        it('aggregates all capabilities', () => {
            setWindowProp('electronAPI', {});
            const caps = getBrowserCapabilities();
            expect(caps.isElectron).toBe(true);
            expect(caps.directorySelectionMethod).toBe('electron');
            expect(typeof caps.hasFileSystemAccess).toBe('boolean');
            expect(typeof caps.hasClipboardAPI).toBe('boolean');
        });
    });

    describe('hasBrowserNotifications', () => {
        it('returns false when Notification not in window', () => {
            deleteWindowProp('Notification');
            expect(hasBrowserNotifications()).toBe(false);
        });

        it('returns true when Notification in window', () => {
            setWindowProp('Notification', function () {} as any);
            expect(hasBrowserNotifications()).toBe(true);
        });
    });

    describe('getNotificationPermission', () => {
        it('returns unsupported when no Notification API', () => {
            deleteWindowProp('Notification');
            expect(getNotificationPermission()).toBe('unsupported');
        });

        it('returns the current permission value', () => {
            const NotificationMock: any = function () {};
            NotificationMock.permission = 'granted';
            setWindowProp('Notification', NotificationMock);
            expect(getNotificationPermission()).toBe('granted');
        });
    });

    describe('requestNotificationPermission', () => {
        it('returns unsupported when no Notification API', async () => {
            deleteWindowProp('Notification');
            await expect(requestNotificationPermission()).resolves.toBe('unsupported');
        });

        it('returns granted immediately when already granted', async () => {
            const NotificationMock: any = function () {};
            NotificationMock.permission = 'granted';
            NotificationMock.requestPermission = vi.fn();
            setWindowProp('Notification', NotificationMock);
            await expect(requestNotificationPermission()).resolves.toBe('granted');
            expect(NotificationMock.requestPermission).not.toHaveBeenCalled();
        });

        it('returns denied immediately when already denied', async () => {
            const NotificationMock: any = function () {};
            NotificationMock.permission = 'denied';
            NotificationMock.requestPermission = vi.fn();
            setWindowProp('Notification', NotificationMock);
            await expect(requestNotificationPermission()).resolves.toBe('denied');
            expect(NotificationMock.requestPermission).not.toHaveBeenCalled();
        });

        it('requests permission when default and returns result', async () => {
            const NotificationMock: any = function () {};
            NotificationMock.permission = 'default';
            NotificationMock.requestPermission = vi.fn().mockResolvedValue('granted');
            setWindowProp('Notification', NotificationMock);
            await expect(requestNotificationPermission()).resolves.toBe('granted');
            expect(NotificationMock.requestPermission).toHaveBeenCalled();
        });

        it('returns denied when requestPermission throws', async () => {
            const NotificationMock: any = function () {};
            NotificationMock.permission = 'default';
            NotificationMock.requestPermission = vi.fn().mockRejectedValue(new Error('boom'));
            setWindowProp('Notification', NotificationMock);
            vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(requestNotificationPermission()).resolves.toBe('denied');
        });
    });

    describe('sendBrowserNotification', () => {
        it('returns null when notifications unsupported', () => {
            deleteWindowProp('Notification');
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            expect(sendBrowserNotification('Hi')).toBeNull();
        });

        it('returns null when permission not granted', () => {
            const NotificationMock: any = function () {};
            NotificationMock.permission = 'default';
            setWindowProp('Notification', NotificationMock);
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            expect(sendBrowserNotification('Hi')).toBeNull();
        });

        it('creates and returns a Notification when granted', () => {
            const instances: any[] = [];
            const NotificationMock: any = function (this: any, title: string, opts: any) {
                this.title = title;
                this.options = opts;
                this.close = vi.fn();
                instances.push(this);
            };
            NotificationMock.permission = 'granted';
            setWindowProp('Notification', NotificationMock);

            const n = sendBrowserNotification('Hello', { body: 'World' });
            expect(n).not.toBeNull();
            expect(instances).toHaveLength(1);
            expect(instances[0].title).toBe('Hello');
            expect(typeof (n as any).onclick).toBe('function');
        });

        it('dispatches taskClick event on click when data.taskId present', () => {
            const NotificationMock: any = function (this: any) {
                this.close = vi.fn();
            };
            NotificationMock.permission = 'granted';
            setWindowProp('Notification', NotificationMock);
            const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});
            const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

            const n = sendBrowserNotification('T', { data: { taskId: 'task-9' } });
            (n as any).onclick();

            expect(focusSpy).toHaveBeenCalled();
            const evt = dispatchSpy.mock.calls.find(c => (c[0] as CustomEvent).type === 'notification:taskClick');
            expect(evt).toBeDefined();
            expect((evt![0] as CustomEvent).detail).toEqual({ taskId: 'task-9' });
        });

        it('returns null when Notification constructor throws', () => {
            const NotificationMock: any = function () { throw new Error('nope'); };
            NotificationMock.permission = 'granted';
            setWindowProp('Notification', NotificationMock);
            vi.spyOn(console, 'error').mockImplementation(() => {});
            expect(sendBrowserNotification('X')).toBeNull();
        });
    });

    describe('sendTaskCompletionNotification', () => {
        function grantNotifications() {
            const NotificationMock: any = function (this: any, title: string, opts: any) {
                this.title = title;
                this.options = opts;
                this.close = vi.fn();
            };
            NotificationMock.permission = 'granted';
            setWindowProp('Notification', NotificationMock);
        }

        it('returns true and uses task name + last message', () => {
            grantNotifications();
            expect(sendTaskCompletionNotification({ taskName: 'Build', lastMessage: 'done', taskId: 't1' })).toBe(true);
        });

        it('returns false when notifications unsupported', () => {
            deleteWindowProp('Notification');
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            expect(sendTaskCompletionNotification({ taskName: 'Build' })).toBe(false);
        });

        it('truncates long task name and message', () => {
            let captured: any;
            const NotificationMock: any = function (this: any, title: string, opts: any) {
                captured = { title, opts };
                this.close = vi.fn();
            };
            NotificationMock.permission = 'granted';
            setWindowProp('Notification', NotificationMock);

            const longName = 'a'.repeat(100);
            const longMsg = 'b'.repeat(300);
            sendTaskCompletionNotification({ taskName: longName, lastMessage: longMsg });
            expect(captured.title.endsWith('...')).toBe(true);
            expect(captured.title.length).toBe(63); // 60 + '...'
            expect(captured.opts.body.endsWith('...')).toBe(true);
            expect(captured.opts.body.length).toBe(203); // 200 + '...'
        });

        it('falls back to defaults when no name/message', () => {
            let captured: any;
            const NotificationMock: any = function (this: any, title: string, opts: any) {
                captured = { title, opts };
                this.close = vi.fn();
            };
            NotificationMock.permission = 'granted';
            setWindowProp('Notification', NotificationMock);
            sendTaskCompletionNotification({});
            expect(captured.title).toBe('Task Complete');
            expect(captured.opts.body).toBe('Task finished executing');
        });
    });

    describe('sendTaskWaitingInputNotification', () => {
        function capture(): { get: () => any } {
            const box: any = {};
            const NotificationMock: any = function (this: any, title: string, opts: any) {
                box.title = title;
                box.opts = opts;
                this.close = vi.fn();
            };
            NotificationMock.permission = 'granted';
            setWindowProp('Notification', NotificationMock);
            return { get: () => box };
        }

        it('labels permission input type', () => {
            const c = capture();
            sendTaskWaitingInputNotification({ taskName: 'X', inputType: 'permission' });
            expect(c.get().title).toContain('Needs Permission');
        });

        it('labels question input type', () => {
            const c = capture();
            sendTaskWaitingInputNotification({ taskName: 'X', inputType: 'question' });
            expect(c.get().title).toContain('Has a Question');
        });

        it('labels confirmation input type', () => {
            const c = capture();
            sendTaskWaitingInputNotification({ taskName: 'X', inputType: 'confirmation' });
            expect(c.get().title).toContain('Needs Confirmation');
        });

        it('defaults to Needs Input and Task prefix without name', () => {
            const c = capture();
            const r = sendTaskWaitingInputNotification({});
            expect(r).toBe(true);
            expect(c.get().title).toBe('Task Needs Input');
        });

        it('takes the tail of long recentOutput', () => {
            const c = capture();
            const out = 'x'.repeat(100) + 'TAILMARK';
            sendTaskWaitingInputNotification({ taskName: 'X', recentOutput: out.padEnd(200, 'y') });
            expect(c.get().opts.body.length).toBe(150);
        });
    });

    describe('sound playback', () => {
        // The module caches a single persistent AudioContext. We install a mock
        // AudioContext whose `state` we can flip to drive both code paths.
        function makeOscillator() {
            return {
                type: '',
                frequency: { setValueAtTime: vi.fn() },
                connect: vi.fn(),
                start: vi.fn(),
                stop: vi.fn(),
            };
        }
        function makeGain() {
            return {
                connect: vi.fn(),
                gain: {
                    setValueAtTime: vi.fn(),
                    exponentialRampToValueAtTime: vi.fn(),
                },
            };
        }

        // The module caches ONE AudioContext for the whole process. We install a
        // single shared mock whose `state` we mutate between tests.
        let ctxState = 'running';
        const sharedCtx: any = {
            get state() { return ctxState; },
            currentTime: 0,
            destination: {},
            resume: vi.fn().mockResolvedValue(undefined),
            createOscillator: vi.fn(makeOscillator),
            createGain: vi.fn(makeGain),
        };

        beforeEach(() => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            setSoundEnabled(true);
            ctxState = 'running';
            sharedCtx.resume.mockClear();
            sharedCtx.createOscillator.mockClear();
            sharedCtx.createGain.mockClear();
            const AudioCtxMock: any = function () { return sharedCtx; };
            setWindowProp('AudioContext', AudioCtxMock);
            // Stub HTML Audio so suspended fallback path is safe
            (global as any).Audio = vi.fn(() => ({ play: vi.fn().mockResolvedValue(undefined) }));
            if (!(global as any).URL.createObjectURL) {
                (global as any).URL.createObjectURL = vi.fn(() => 'blob:chime');
            }
        });

        it('does nothing when sound disabled', () => {
            setSoundEnabled(false);
            playTaskCompletionSound();
            expect(sharedCtx.createOscillator).not.toHaveBeenCalled();
        });

        it('plays via Web Audio when context is running', () => {
            ctxState = 'running';
            playTaskCompletionSound();
            expect(sharedCtx.createOscillator).toHaveBeenCalledTimes(3);
            expect(sharedCtx.createGain).toHaveBeenCalledTimes(3);
        });

        it('attempts resume + HTML Audio fallback when suspended', () => {
            ctxState = 'suspended';
            playTaskCompletionSound();
            expect(sharedCtx.resume).toHaveBeenCalled();
        });

        it('playTestSound forces playback even if disabled', () => {
            setSoundEnabled(false);
            ctxState = 'running';
            playTestSound();
            expect(sharedCtx.createOscillator).toHaveBeenCalled();
            expect(isSoundEnabled()).toBe(false);
        });

        it('setupAudioUnlock registers document listeners without throwing', () => {
            const addSpy = vi.spyOn(document, 'addEventListener');
            setupAudioUnlock();
            const types = addSpy.mock.calls.map(c => c[0]);
            expect(types).toContain('click');
            expect(types).toContain('touchstart');
        });
    });

    describe('isSoundEnabled / setSoundEnabled', () => {
        // Note: the module caches sound state in a module-level variable.
        // setSoundEnabled sets the cache directly so we drive it via that.
        it('reflects value set via setSoundEnabled', () => {
            setSoundEnabled(false);
            expect(isSoundEnabled()).toBe(false);
            expect(localStorage.getItem('claudia-completion-sound')).toBe('false');

            setSoundEnabled(true);
            expect(isSoundEnabled()).toBe(true);
            expect(localStorage.getItem('claudia-completion-sound')).toBe('true');
        });
    });
});
