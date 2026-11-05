/** Integrated mode never falls back to a local session on configuration errors. */
export function isDoskaIntegrated(): boolean {
  const mode = process.env.DOSKA_AUTH_MODE ?? "standalone";
  if (mode !== "standalone" && mode !== "platform") {
    throw new Error("DOSKA_AUTH_MODE must be standalone or platform");
  }
  return mode === "platform";
}
