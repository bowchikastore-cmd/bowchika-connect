import { usePreferences } from "../theme-provider";

export default function SettingsPage() {
  const { theme, density, setTheme, setDensity } = usePreferences();

  return (
    <s-page heading="Settings">
      <section className="bc-settings" aria-labelledby="settings-heading">
        <div>
          <h1 id="settings-heading" style={{ fontSize: 24, margin: "0 0 6px" }}>Settings</h1>
          <p style={{ color: "var(--bc-muted)", margin: 0 }}>Choose how Bowchika Connect looks in Shopify Admin.</p>
        </div>

        <section className="bc-settings-group" aria-labelledby="appearance-heading">
          <div>
            <h2 id="appearance-heading" style={{ fontSize: 16, margin: 0 }}>Appearance</h2>
            <p style={{ color: "var(--bc-muted)", fontSize: 13, margin: "5px 0 0" }}>Applies across the app and is saved in this browser.</p>
          </div>
          <div className="bc-settings-choice-row" role="group" aria-label="Theme">
            <button type="button" className="bc-setting-choice" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>Light</button>
            <button type="button" className="bc-setting-choice" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>Dark</button>
          </div>
        </section>

        <section className="bc-settings-group" aria-labelledby="density-heading">
          <div>
            <h2 id="density-heading" style={{ fontSize: 16, margin: 0 }}>Interface spacing</h2>
            <p style={{ color: "var(--bc-muted)", fontSize: 13, margin: "5px 0 0" }}>Choose comfortable or compact spacing for cards and controls.</p>
          </div>
          <div className="bc-settings-choice-row" role="group" aria-label="Interface spacing">
            <button type="button" className="bc-setting-choice" aria-pressed={density === "comfortable"} onClick={() => setDensity("comfortable")}>Comfortable</button>
            <button type="button" className="bc-setting-choice" aria-pressed={density === "compact"} onClick={() => setDensity("compact")}>Compact</button>
          </div>
        </section>
      </section>
    </s-page>
  );
}