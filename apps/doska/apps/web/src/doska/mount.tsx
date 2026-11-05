import { StrictMode, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import ru from "@i18n/ru-RU.json";
import en from "@i18n/en-US.json";
import { DoskaApp } from "./app";
import { DoskaSession } from "./session";
import { DoskaLiveUpdates } from "./live-updates";
import "./shell.css";
import "./custom-theme.css";
document.title = "Задачи — PL";
const i18n = createInstance();
const initialized = i18n.use(initReactI18next).init({
  lng: "ru-RU",
  fallbackLng: "en-US",
  resources: { "ru-RU": ru, "en-US": en },
  defaultNS: "doska",
  interpolation: { escapeValue: false },
});
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
});
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="doska-app doska-gate">
        <section className="doska-panel">
          <h1>{i18n.t("app")}</h1>
          <p>{i18n.t("pageError")}</p>
          <button onClick={() => location.reload()}>{i18n.t("retry")}</button>
        </section>
      </div>
    ) : (
      this.props.children
    );
  }
}
const element = document.getElementById("root");
let root: Root | undefined;
let active = true;
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    active = false;
    root?.unmount();
    queryClient.clear();
  });
}
void initialized.then(() => {
  if (element && active) {
    root = createRoot(element);
    root.render(
      <StrictMode>
        <I18nextProvider i18n={i18n}>
          <Boundary>
            <QueryClientProvider client={queryClient}>
              <DoskaSession>
                <DoskaLiveUpdates>
                  <DoskaApp />
                </DoskaLiveUpdates>
              </DoskaSession>
            </QueryClientProvider>
          </Boundary>
        </I18nextProvider>
      </StrictMode>,
    );
  }
});
