import { useState, useLayoutEffect } from 'react';
import { useTaskStore } from '../stores/taskStore';
import { ThemeMode } from '../types/theme';

function resolveSystemTheme(): ThemeMode {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function useTheme(): { effectiveTheme: ThemeMode } {
    const themePreference = useTaskStore(s => s.themePreference);

    const [effectiveTheme, setEffectiveTheme] = useState<ThemeMode>(() => {
        if (themePreference !== 'system') return themePreference;
        return resolveSystemTheme();
    });

    useLayoutEffect(() => {
        if (themePreference !== 'system') {
            setEffectiveTheme(themePreference);
            document.documentElement.setAttribute('data-theme', themePreference);
            return;
        }

        const resolved = resolveSystemTheme();
        setEffectiveTheme(resolved);
        document.documentElement.setAttribute('data-theme', resolved);

        const mql = window.matchMedia('(prefers-color-scheme: light)');
        const handler = (e: MediaQueryListEvent) => {
            const mode: ThemeMode = e.matches ? 'light' : 'dark';
            setEffectiveTheme(mode);
            document.documentElement.setAttribute('data-theme', mode);
        };
        mql.addEventListener('change', handler);
        return () => mql.removeEventListener('change', handler);
    }, [themePreference]);

    return { effectiveTheme };
}
