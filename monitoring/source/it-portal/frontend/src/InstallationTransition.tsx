import { ArrowUpRight } from "lucide-react";
import { Button } from "./components/ui/button";

const storageKey = "pl.installation-transition";
const lifetime = 60 * 60 * 1000;
type Transition = {
  operationId: string;
  nextOrigin: string;
  acceptedAt: number;
};

export function pendingInstallationTransition(): Transition | undefined {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return;
    const value = JSON.parse(raw) as Transition;
    const url = new URL(value.nextOrigin);
    if (
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
        value.operationId,
      ) ||
      !Number.isFinite(value.acceptedAt) ||
      Date.now() - value.acceptedAt > lifetime ||
      value.acceptedAt > Date.now() + 5000 ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      sessionStorage.removeItem(storageKey);
      return;
    }
    return { ...value, nextOrigin: url.origin };
  } catch {
    return;
  }
}

export function rememberInstallationTransition(
  operationId: string,
  nextOrigin: string,
) {
  try {
    if (new URL(nextOrigin).origin === location.origin) return;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ operationId, nextOrigin, acceptedAt: Date.now() }),
    );
    pendingInstallationTransition();
  } catch {
    /* Storage can be unavailable; the accepted operation still runs. */
  }
}

export function settleInstallationTransition(value: {
  public_url: string;
  operation?: { operation_id: string; phase: string };
}) {
  if (!pendingInstallationTransition()) return;
  try {
    if (
      new URL(value.public_url).origin === location.origin &&
      (!value.operation ||
        ["complete", "failed", "rolled_back"].includes(value.operation.phase))
    ) {
      sessionStorage.removeItem(storageKey);
    }
  } catch {
    /* Keep the accepted address until a valid server response arrives. */
  }
}

export function InstallationTransitionNotice({ retry }: { retry: () => void }) {
  const transition = pendingInstallationTransition();
  if (!transition) return null;
  const href = transition.nextOrigin + "/#settings?section=installation";
  return (
    <section
      className="installation-transition"
      aria-label="Переход на новый адрес PL"
    >
      <h1>Адрес PL изменяется</h1>
      <p>
        Параметры приняты. Во время перезапуска прежний адрес может быть
        недоступен.
      </p>
      <p>
        Откройте новый адрес. Если страница ещё не отвечает, подождите несколько
        секунд и повторите переход.
      </p>
      <p>
        <a href={href}>
          {transition.nextOrigin} <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </p>
      <Button variant="secondary" onClick={retry}>
        Проверить прежний адрес
      </Button>
    </section>
  );
}
