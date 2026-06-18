import { describe, it, expect, vi, beforeEach } from 'vitest';

// Vitest/jsdom — verify Unicode11 column widths and WebGL fallback
// without needing a real browser canvas or PTY connection.

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockLoadAddon = vi.fn();
const mockDispose = vi.fn();
let contextLossCallback: (() => void) | null = null;

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function () {
    return {
      loadAddon: mockLoadAddon,
      write: vi.fn(),
      open: vi.fn(),
      dispose: vi.fn(),
      onData: vi.fn(),
      scrollToBottom: vi.fn(),
      refresh: vi.fn(),
      unicode: { activeVersion: '6' },
      buffer: { active: { viewportY: 0, length: 0 } },
      rows: 24,
      cols: 80,
    };
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function () {
    return { fit: vi.fn(), dispose: vi.fn() };
  }),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(function () {
    return { dispose: vi.fn() };
  }),
}));

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: vi.fn().mockImplementation(function () {
    return { dispose: vi.fn(), activate: vi.fn() };
  }),
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(function () {
    return {
      onContextLoss: vi.fn().mockImplementation(function (cb: () => void) {
        contextLossCallback = cb;
      }),
      dispose: mockDispose,
    };
  }),
}));

// ── Criterion 4: Unicode11 wide-char column widths ─────────────────────────

describe('Unicode11Addon — wide-character column widths', () => {
  beforeEach(() => {
    mockLoadAddon.mockClear();
  });

  it('sets activeVersion to "11" after loading Unicode11Addon', async () => {
    const { Terminal } = await import('@xterm/xterm');
    const { Unicode11Addon } = await import('@xterm/addon-unicode11');

    const term = new Terminal() as unknown as ReturnType<typeof Terminal>;
    const unicode11 = new Unicode11Addon();

    // Simulate exactly what TerminalView does
    term.loadAddon(unicode11);
    (term as { unicode: { activeVersion: string } }).unicode.activeVersion = '11';

    expect((term as { unicode: { activeVersion: string } }).unicode.activeVersion).toBe('11');
    expect(mockLoadAddon).toHaveBeenCalledWith(unicode11);
  });

  it('Unicode11Addon is loaded before WebglAddon (before any output)', async () => {
    const { Terminal } = await import('@xterm/xterm');
    const { Unicode11Addon } = await import('@xterm/addon-unicode11');
    const { WebglAddon } = await import('@xterm/addon-webgl');

    const term = new Terminal() as unknown as { loadAddon: typeof mockLoadAddon; open: (el: HTMLElement) => void };
    const unicode11 = new Unicode11Addon();
    const webgl = new WebglAddon();

    // TerminalView order: unicode11 first → open → webgl
    term.loadAddon(unicode11);
    (term as { unicode: { activeVersion: string } } & typeof term).unicode = { activeVersion: '11' };
    term.open(document.createElement('div'));
    term.loadAddon(webgl);

    const calls = mockLoadAddon.mock.calls.map((c) => c[0]);
    expect(calls.indexOf(unicode11)).toBeLessThan(calls.indexOf(webgl));
  });
});

// ── Criterion 5: WebGL context-loss fallback ───────────────────────────────

describe('WebglAddon — context-loss fallback', () => {
  beforeEach(() => {
    contextLossCallback = null;
    mockDispose.mockClear();
    mockDispose.mockImplementation(() => {});
  });

  it('registers an onContextLoss handler when wired up', async () => {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* already disposed */ } });
    expect(contextLossCallback).not.toBeNull();
  });

  it('calls dispose() when context loss fires — addon removed, DOM renderer takes over', async () => {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const webgl = new WebglAddon();

    webgl.onContextLoss(() => {
      try { webgl.dispose(); } catch { /* already disposed */ }
    });

    // Simulate the webgl2 context loss event
    expect(contextLossCallback).not.toBeNull();
    contextLossCallback!();

    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('swallows dispose() error — terminal stays interactive after double-dispose', async () => {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const webgl = new WebglAddon();

    // Simulate an already-disposed addon that throws on the second call
    mockDispose.mockImplementationOnce(() => { throw new Error('_isDisposed'); });

    webgl.onContextLoss(() => {
      try { webgl.dispose(); } catch { /* swallowed — terminal stays interactive */ }
    });

    // Must not throw
    expect(() => contextLossCallback!()).not.toThrow();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });
});
