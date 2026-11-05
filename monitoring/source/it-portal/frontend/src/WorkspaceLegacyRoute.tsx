import { useEffect } from "react";
import { openWorkspaceCheck } from "./WorkspaceChecks";
import { openWorkspaceProblems } from "./WorkspaceProblems";

export function WorkspaceLegacyRoute({
  kind,
}: {
  kind: "problems" | "tools" | "reports";
}) {
  useEffect(() => {
    if (kind === "reports") {
      location.replace("/reports/");
      return;
    }
    location.hash = "home";
    if (kind === "tools") openWorkspaceCheck();
    if (kind === "problems") openWorkspaceProblems();
  }, [kind]);
  return null;
}
