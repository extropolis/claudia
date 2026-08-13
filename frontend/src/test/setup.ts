import { vi } from 'vitest';
import '@testing-library/jest-dom';

// Mock localStorage
const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => {
            store[key] = value;
        },
        removeItem: (key: string) => {
            delete store[key];
        },
        clear: () => {
            store = {};
        },
    };
})();

Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
});

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    }),
});

// Mock ResizeObserver
global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
};

// jsdom gaps that component tests trip over. Cheap no-ops so a component can
// mount without every test file re-stubbing the same primitives.
if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
}
if (!HTMLCanvasElement.prototype.getContext) {
    HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

// Mock WebSocket
class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    url: string;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(url: string) {
        this.url = url;
        setTimeout(() => {
            this.readyState = MockWebSocket.OPEN;
            if (this.onopen) {
                this.onopen(new Event('open'));
            }
        }, 0);
    }

    send(_data: string | ArrayBuffer | Blob | ArrayBufferView) {}
    close() {
        this.readyState = MockWebSocket.CLOSED;
    }
    addEventListener() {}
    removeEventListener() {}
}

global.WebSocket = MockWebSocket as unknown as typeof WebSocket;

// No test may reach the network.
//
// Without this, a background request a store fires and forgets — taskStore
// PUTs /api/config to sync the Deepgram key, for instance — escapes to the
// real network. In CI it fails, and its `.catch()` logs AFTER the test file
// has finished, so vitest tears down mid-log and reports
// "Closing rpc while onUserConsoleLog was pending", failing the whole run
// with an error that names an innocent test file.
//
// Default every fetch to an immediately-resolved empty JSON 200. Tests that
// care about a response override it with vi.spyOn(global, 'fetch') / vi.mocked.
global.fetch = vi.fn(async () =>
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
) as unknown as typeof fetch;
