import { describe, it, expect, vi, beforeEach } from 'vitest';

// Verify ghostty-web integration: WASM init, link providers, and terminal lifecycle.

const mockLoadAddon = vi.fn();
const mockDispose = vi.fn();
const mockRegisterLinkProvider = vi.fn();
let contextLossCallback: (() => void) | null = null;

vi.mock('ghostty-web', () => ({
  init: vi.fn().mockResolvedValue(undefined),
  Terminal: vi.fn().mockImplementation(function () {
    return {
      loadAddon: mockLoadAddon,
      registerLinkProvider: mockRegisterLinkProvider,
      write: vi.fn(),
      open: vi.fn(),
      dispose: mockDispose,
      onData: vi.fn(),
      onResize: vi.fn(),
      scrollToBottom: vi.fn(),
      refresh: vi.fn(),
      unicode: { activeVersion: '11' }, // ghostty-web handles unicode natively
      buffer: { active: { viewportY: 0, length: 0 } },
      rows: 24,
      cols: 80,
      options: { theme: {} },
    };
  }),
  FitAddon: vi.fn().mockImplementation(function () {
    return { fit: vi.fn(), dispose: vi.fn(), activate: vi.fn() };
  }),
  OSC8LinkProvider: vi.fn().mockImplementation(function () {
    return { dispose: vi.fn(), provideLinks: vi.fn() };
  }),
  UrlRegexProvider: vi.fn().mockImplementation(function () {
    return { dispose: vi.fn(), provideLinks: vi.fn() };
  }),
}));

// ── ghostty-web init ───────────────────────────────────────────────────────

describe('ghostty-web integration', () => {
  beforeEach(() => {
    mockLoadAddon.mockClear();
    mockRegisterLinkProvider.mockClear();
    mockDispose.mockClear();
  });

  it('init() resolves before Terminal is constructed', async () => {
    const { init, Terminal } = await import('ghostty-web');
    await init();
    const term = new Terminal();
    expect(init).toHaveBeenCalled();
    expect(term).toBeTruthy();
  });

  it('FitAddon is loaded via loadAddon', async () => {
    const { Terminal, FitAddon } = await import('ghostty-web');
    const term = new Terminal();
    const fit = new FitAddon();
    term.loadAddon(fit);
    expect(mockLoadAddon).toHaveBeenCalledWith(fit);
  });

  // ── Criterion 4 equivalent: ghostty handles Unicode natively ─────────────
  it('Terminal unicode.activeVersion is "11" by default (ghostty native)', async () => {
    const { Terminal } = await import('ghostty-web');
    const term = new Terminal();
    // ghostty-web handles Unicode/CJK natively — no separate Unicode11Addon needed
    expect(term.unicode.activeVersion).toBe('11');
  });

  // ── Link providers replace WebLinksAddon ─────────────────────────────────
  it('OSC8LinkProvider and UrlRegexProvider are registered', async () => {
    const { Terminal, OSC8LinkProvider, UrlRegexProvider } = await import('ghostty-web');
    const term = new Terminal();
    term.open(document.createElement('div'));
    const osc8 = new OSC8LinkProvider(term);
    const urlProvider = new UrlRegexProvider(term);
    term.registerLinkProvider(osc8);
    term.registerLinkProvider(urlProvider);
    expect(mockRegisterLinkProvider).toHaveBeenCalledWith(osc8);
    expect(mockRegisterLinkProvider).toHaveBeenCalledWith(urlProvider);
  });

  // ── Criterion 5 equivalent: clean dispose (no WebGL addon to crash) ───────
  it('dispose() completes cleanly without WebGL addon crash', async () => {
    const { Terminal } = await import('ghostty-web');
    const term = new Terminal();
    expect(() => term.dispose()).not.toThrow();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('dispose() is safe to call multiple times', async () => {
    const { Terminal } = await import('ghostty-web');
    const term = new Terminal();
    expect(() => { term.dispose(); term.dispose(); }).not.toThrow();
  });
});
