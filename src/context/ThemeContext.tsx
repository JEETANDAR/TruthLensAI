import React, { createContext, useContext, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark';

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = 'truthlens-theme';

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  setTheme: () => {},
  toggleTheme: () => {},
});

function readInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(readInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Ignore storage quota errors in restricted frames
    }
  }, [theme]);

  const setTheme = (mode: ThemeMode) => setThemeState(mode);
  const toggleTheme = () => setThemeState((prev) => (prev === 'light' ? 'dark' : 'light'));

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export function useChartTheme() {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  return {
    isDark,
    gridStroke: isDark ? '#1E293B' : '#E2E8F0',
    axisStroke: isDark ? '#94A3B8' : '#64748B',
    tooltipStyle: {
      backgroundColor: isDark ? '#111827' : '#FFFFFF',
      borderColor: isDark ? '#334155' : '#CBD5E1',
      color: isDark ? '#F1F5F9' : '#0F172A',
      fontSize: '12px',
      borderRadius: '6px',
      boxShadow: isDark
        ? '0 8px 24px rgba(2, 6, 23, 0.45)'
        : '0 8px 24px rgba(15, 23, 42, 0.08)',
    } as React.CSSProperties,
    primaryBar: isDark ? '#3B82F6' : '#2563EB',
    cyanLine: isDark ? '#38BDF8' : '#0891B2',
    tealBar: isDark ? '#2DD4BF' : '#0D9488',
    indigoBar: isDark ? '#818CF8' : '#4F46E5',
    amberBar: isDark ? '#FBBF24' : '#D97706',
    coralBar: isDark ? '#FB7185' : '#E11D48',
  };
}
