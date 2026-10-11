import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { setResponseStreamingPreference } from "../../src/lib/response-streaming";
import { SettingsOverlay } from "../../src/pages/SettingsOverlay";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const streamResponses = params.get("stream") !== "off";

function SettingsFixture() {
  return (
    <MemoryRouter>
      <main className="min-h-screen bg-background text-foreground">
        <p data-testid="fixture-note" className="px-4 py-3 text-[12.5px] text-muted-foreground/80">
          {`Fixture: Settings overlay · Stream replies ${streamResponses ? "on" : "off"}`}
        </p>
        <SettingsOverlay
          email="owner@example.test"
          name="Owner"
          avatarStyle="robot"
          onAvatarStyleChange={() => Promise.resolve()}
          memoryConfig={null}
          onMemoryConfigChange={() => {}}
          onClose={() => {}}
        />
      </main>
    </MemoryRouter>
  );
}

void bootstrapI18n("en").then(() => {
  setResponseStreamingPreference(streamResponses ? "on" : "off");
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <SettingsFixture />
    </I18nProvider>,
  );
});
