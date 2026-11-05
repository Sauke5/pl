import { apiRouter, createRoute, jsonResponse, z } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { memberErrors } from "../projects/member-schema";
import { projectParams } from "../projects/schema";
import { labelResponse, labelsQuery } from "./schema";
import { listProjectLabels } from "./service";
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const routes = router.openapi(
  createRoute({
    method: "get",
    path: "/projects/{id}/labels",
    operationId: "doskaListProjectLabels",
    tags: ["Doska labels"],
    summary: "Find labels used in the current project",
    request: { params: projectParams, query: labelsQuery },
    responses: {
      200: jsonResponse("Project label suggestions", z.array(labelResponse)),
      ...memberErrors,
    },
  }),
  async (c) =>
    c.json(
      await listProjectLabels(
        c.get("userId"),
        c.req.valid("param").id,
        c.req.valid("query"),
      ),
      200,
    ),
);
export default routes;
