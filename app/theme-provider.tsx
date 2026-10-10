import { createContext, useContext, useEffect, useState } from "react";
import type { PropsWithChildren } from "react";

type Theme = "light" | "dark";
type Density = "comfortable" | "compact";

type Preferences = {
  theme: Theme;
  density: Density;
};

type PreferencesContextValue = Preferences & {
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
};

const STORAGE_KEY = "bowchika-connect.preferences.v1";
const defaultPreferences: Preferences = { theme: "light", density: "comfortable" };
const PreferencesContext = createContext<PreferencesContextValue | null>(null);

const readPreferences = (): Preferences => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaultPreferences;
    const parsed = JSON.parse(stored) as Partial<Preferences>;
    return {
      theme: parsed.theme === "dark" ? "dark" : "light",
      density: parsed.density === "compact" ? "compact" : "comfortable",
    };
  } catch {
    return defaultPreferences;
  }
};

export function ThemeProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);

  useEffect(() => {
    setPreferences(readPreferences());
    setPreferencesLoaded(true);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    document.documentElement.dataset.density = preferences.density;
    if (!preferencesLoaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
  }, [preferences, preferencesLoaded]);

  const value: PreferencesContextValue = {
    ...preferences,
    setTheme: (theme) => setPreferences((current) => ({ ...current, theme })),
    setDensity: (density) => setPreferences((current) => ({ ...current, density })),
  };

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export const usePreferences = () => {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error("usePreferences must be used inside ThemeProvider.");
  return context;
};