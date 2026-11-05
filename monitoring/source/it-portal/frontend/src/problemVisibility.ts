import type { Problem } from "./types";

export function isProblemSuppressed(problem: Problem) {
  return (
    problem.labels?.portal_silenced === "true" ||
    problem.labels?.portal_inhibited === "true" ||
    problem.labels?.portal_alert_state === "suppressed"
  );
}

export function isProblemMuted(problem: Problem) {
  return Boolean(problem.hidden) || isProblemSuppressed(problem);
}

export function requiresAttention(problem: Problem) {
  return problem.status === "firing" && !isProblemMuted(problem);
}
