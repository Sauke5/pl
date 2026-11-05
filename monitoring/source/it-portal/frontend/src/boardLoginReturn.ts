import { clearLoginReturn } from "./loginReturn";

const key = "pl-ui-login-board-service";
export function isBoardServiceID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function clearBoardLoginReturn() {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // A direct login still works when storage is unavailable.
  }
}
export function pendingBoardLoginReturn(): string | undefined {
  // An explicit deep link takes precedence over an earlier card selection.
  if (
    new URLSearchParams(location.search).has("return_to") ||
    (location.pathname === "/401" && location.hash.startsWith("#return_to:"))
  ) {
    clearBoardLoginReturn();
    return undefined;
  }
  try {
    const id = sessionStorage.getItem(key);
    if (isBoardServiceID(id)) return id;
    clearBoardLoginReturn();
  } catch {
    // Storage is optional.
  }
  return undefined;
}
export function selectBoardLoginReturn(id: string): boolean {
  if (!isBoardServiceID(id)) return false;
  try {
    // Store the ID only. The destination is resolved after login, never persisted.
    sessionStorage.setItem(key, id);
    clearLoginReturn();
    const url = new URL(location.href);
    url.searchParams.delete("return_to");
    history.replaceState(
      history.state,
      "",
      url.pathname + url.search + url.hash,
    );
    return true;
  } catch {
    clearBoardLoginReturn();
    return false;
  }
}
