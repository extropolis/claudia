/**
 * Shared test fixtures.
 *
 * - `consoleErrors` / `pageErrors` capture browser-side failures for every
 *   test, so a spec can assert the flow it drives produced no JS errors.
 * The desktop viewport is set in playwright.config.ts (`use.viewport`) rather
 * than here: Claudia switches to a mobile layout at <= 768px, where the main
 * panel, terminal and file explorer are not rendered at all.
 */
import { test as base, expect } from '@playwright/test';
import { BACKEND_PORT } from '../harness/env.js';

/**
 * HARD SAFETY NET — the browser must never reach the developer's live Claudia
 * on 4001/5173.
 *
 * This is not belt-and-braces paranoia: it already happened once. The frontend
 * resolves its backend port at BUILD time (VITE_CLAUDIA_BACKEND_PORT), so a
 * bundle built without that variable silently falls back to 4001 and the suite
 * happily drives the developer's real instance — creating workspaces and
 * spawning real Claude sessions. Nothing in the test code looks wrong when
 * that happens, which is exactly what makes it dangerous.
 *
 * So we forbid it in the browser itself: WebSocket, fetch and XHR all throw on
 * a forbidden port. A misbuilt bundle now fails loudly on the first connection
 * attempt instead of quietly succeeding against the wrong server.
 */
const PORT_GUARD = `
(() => {
    const FORBIDDEN = /:(4001|5173)(\\/|$|\\?)/;
    const refuse = (url) => {
        throw new Error('E2E PORT GUARD: refused connection to developer dev server: ' + url);
    };
    const check = (url) => { if (FORBIDDEN.test(String(url))) refuse(url); };

    const NativeWebSocket = window.WebSocket;
    const GuardedWebSocket = function (url, protocols) {
        check(url);
        return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    };
    GuardedWebSocket.prototype = NativeWebSocket.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
        GuardedWebSocket[k] = NativeWebSocket[k];
    }
    window.WebSocket = GuardedWebSocket;

    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
        check(typeof input === 'string' ? input : (input && input.url) || '');
        return nativeFetch.call(this, input, init);
    };

    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        check(url);
        return nativeOpen.call(this, method, url, ...rest);
    };
})();
`;

/** Console noise that is not a defect and would make every test flaky. */
const IGNORED_CONSOLE = [
    /Download the React DevTools/i,
    /favicon\.ico/i,
    /ResizeObserver loop/i,
];

/**
 * Force xterm.js onto its DOM renderer.
 *
 * TerminalView loads WebglAddon, which paints cells into a <canvas> — the
 * rendered text is then invisible to the DOM and unassertable. WebglAddon's
 * activate() throws synchronously when WebGL2 is unavailable, and TerminalView
 * wraps loadAddon in try/catch and falls back to the DOM renderer (a real,
 * supported, CSS-styled code path). Denying the webgl contexts is deterministic
 * across machines and headless modes, unlike Chromium GPU flags.
 */
const DISABLE_WEBGL = `
(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
        return original.call(this, type, ...rest);
    };
})();
`;

export const test = base.extend<{
    consoleErrors: string[];
    pageErrors: string[];
    domRenderer: void;
    sandboxOnly: void;
}>({
    domRenderer: [async ({ context }, use) => {
        await context.addInitScript(PORT_GUARD);
        await context.addInitScript(DISABLE_WEBGL);
        await use();
    }, { auto: true }],

    // Independently of the in-page guard, assert the app actually reached OUR
    // backend. A bundle pointing somewhere unexpected would otherwise show up
    // only as confusing downstream failures.
    sandboxOnly: [async ({ page }, use) => {
        const sockets: string[] = [];
        page.on('websocket', (ws) => sockets.push(ws.url()));
        await use();
        const stray = sockets.filter((u) => !u.includes(`:${BACKEND_PORT}`));
        expect(stray, 'WebSocket connections must all target the sandboxed backend').toEqual([]);
    }, { auto: true }],

    consoleErrors: async ({ page }, use) => {
        const errors: string[] = [];
        page.on('console', (msg) => {
            if (msg.type() !== 'error') return;
            const text = msg.text();
            if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
            errors.push(text);
        });
        await use(errors);
    },
    pageErrors: async ({ page }, use) => {
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.stack ?? err.message));
        await use(errors);
    },
});

export { expect };
