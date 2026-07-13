import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { useTheme, useEffectiveTheme } from '../useTheme';
import { useTaskStore } from '../../stores/taskStore';

/**
 * Minimal renderHook implementation built on react-dom directly.
 * `@testing-library/react`'s renderHook requires `@testing-library/dom`
 * which is not installed in this project, so we provide a small equivalent.
 */
const activeRoots = new Set<{ root: Root; container: HTMLElement }>();

function renderHook<T>(hook: () => T): { result: { current: T }; rerender: () => void; unmount: () => void } {
    const result = { current: undefined as unknown as T };
    let root: Root;
    const container = document.createElement('div');
    document.body.appendChild(container);

    function TestComponent() {
        result.current = hook();
        return null;
    }

    act(() => {
        root = createRoot(container);
        root.render(React.createElement(TestComponent));
    });

    const entry = { root: root!, container };
    activeRoots.add(entry);

    const unmount = () => {
        if (!activeRoots.has(entry)) return;
        act(() => {
            entry.root.unmount();
        });
        entry.container.remove();
        activeRoots.delete(entry);
    };

    return {
        result,
        rerender: () => {
            act(() => {
                root.render(React.createElement(TestComponent));
            });
        },
        unmount,
    };
}

function unmountAll() {
    for (const entry of Array.from(activeRoots)) {
        act(() => {
            entry.root.unmount();
        });
        entry.container.remove();
        activeRoots.delete(entry);
    }
}

/**
 * Controllable matchMedia mock. `matches` corresponds to
 * '(prefers-color-scheme: light)'. We capture the change handler so tests
 * can simulate the OS theme changing.
 */
function installMatchMedia(initialLight: boolean) {
    let matches = initialLight;
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const mql = {
        get matches() {
            return matches;
        },
        media: '(prefers-color-scheme: light)',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
            listeners.add(cb);
        },
        removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
            listeners.delete(cb);
        },
        dispatchEvent: () => false,
    };
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: vi.fn(() => mql),
    });
    return {
        setMatches(v: boolean) {
            matches = v;
            const evt = { matches: v } as MediaQueryListEvent;
            act(() => {
                listeners.forEach(cb => cb(evt));
            });
        },
        listenerCount: () => listeners.size,
    };
}

function setPreference(pref: 'light' | 'dark' | 'system') {
    act(() => {
        useTaskStore.setState({ themePreference: pref });
    });
}

describe('useTheme', () => {
    beforeEach(() => {
        useTaskStore.setState({ themePreference: 'system' });
        document.documentElement.removeAttribute('data-theme');
    });

    afterEach(() => {
        unmountAll();
        document.documentElement.removeAttribute('data-theme');
    });

    describe('useTheme (with DOM side effects)', () => {
        it('uses explicit dark preference and sets data-theme', () => {
            installMatchMedia(true); // system says light, but preference overrides
            setPreference('dark');
            const { result } = renderHook(() => useTheme());
            expect(result.current.effectiveTheme).toBe('dark');
            expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        });

        it('uses explicit light preference and sets data-theme', () => {
            installMatchMedia(false);
            setPreference('light');
            const { result } = renderHook(() => useTheme());
            expect(result.current.effectiveTheme).toBe('light');
            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        });

        it('resolves system preference to light when OS prefers light', () => {
            installMatchMedia(true);
            setPreference('system');
            const { result } = renderHook(() => useTheme());
            expect(result.current.effectiveTheme).toBe('light');
            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        });

        it('resolves system preference to dark when OS prefers dark', () => {
            installMatchMedia(false);
            setPreference('system');
            const { result } = renderHook(() => useTheme());
            expect(result.current.effectiveTheme).toBe('dark');
            expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        });

        it('reacts to OS theme change while in system mode', () => {
            const mm = installMatchMedia(false); // start dark
            setPreference('system');
            const { result } = renderHook(() => useTheme());
            expect(result.current.effectiveTheme).toBe('dark');

            mm.setMatches(true); // OS switches to light
            expect(result.current.effectiveTheme).toBe('light');
            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        });

        it('removes the media listener on unmount', () => {
            const mm = installMatchMedia(true);
            setPreference('system');
            const { unmount } = renderHook(() => useTheme());
            expect(mm.listenerCount()).toBe(1);
            unmount();
            expect(mm.listenerCount()).toBe(0);
        });

        it('does not attach media listener for explicit preference', () => {
            const mm = installMatchMedia(true);
            setPreference('dark');
            renderHook(() => useTheme());
            expect(mm.listenerCount()).toBe(0);
        });

        it('updates when preference changes from system to light', () => {
            installMatchMedia(false); // system => dark
            setPreference('system');
            const { result, rerender } = renderHook(() => useTheme());
            expect(result.current.effectiveTheme).toBe('dark');

            setPreference('light');
            rerender();
            expect(result.current.effectiveTheme).toBe('light');
            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        });
    });

    describe('useEffectiveTheme (no DOM side effects)', () => {
        it('resolves explicit preference without touching data-theme', () => {
            installMatchMedia(true);
            setPreference('dark');
            const { result } = renderHook(() => useEffectiveTheme());
            expect(result.current).toBe('dark');
            expect(document.documentElement.getAttribute('data-theme')).toBeNull();
        });

        it('resolves system preference based on matchMedia', () => {
            installMatchMedia(true);
            setPreference('system');
            const { result } = renderHook(() => useEffectiveTheme());
            expect(result.current).toBe('light');
            expect(document.documentElement.getAttribute('data-theme')).toBeNull();
        });

        it('reacts to OS theme change in system mode', () => {
            const mm = installMatchMedia(true); // light
            setPreference('system');
            const { result } = renderHook(() => useEffectiveTheme());
            expect(result.current).toBe('light');

            mm.setMatches(false);
            expect(result.current).toBe('dark');
        });

        it('cleans up listener on unmount', () => {
            const mm = installMatchMedia(false);
            setPreference('system');
            const { unmount } = renderHook(() => useEffectiveTheme());
            expect(mm.listenerCount()).toBe(1);
            unmount();
            expect(mm.listenerCount()).toBe(0);
        });
    });
});
