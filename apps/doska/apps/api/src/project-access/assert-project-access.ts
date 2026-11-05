import { isDoskaIntegrated } from "../doska/mode";
import { HTTPException } from "hono/http-exception";
import { findInaccessibleProjectIds } from "./find-inaccessible-project-ids";

export async function assertProjectAccess(
  userId: string,
  projectIds: string | readonly string[],
): Promise<void> {
  const ids = typeof projectIds === "string" ? [projectIds] : projectIds;
  const denied = await findInaccessibleProjectIds(userId, ids);
  if (denied.length > 0) {
    if (isDoskaIntegrated()) {
      throw new HTTPException(404, { message: "Project not found" });
    }
    throw new HTTPException(403, {
      message: "You don't have access to this project",
    });
  }
}
