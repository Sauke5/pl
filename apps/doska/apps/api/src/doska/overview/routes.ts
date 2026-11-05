import { apiRouter, createRoute, jsonResponse } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { memberErrors, pageQuery } from "../projects/member-schema";
import { overviewSchema } from "./schema";
import { getOverview } from "./service";
const router = apiRouter();
router.use("*", async (c, next) =>
  isDoskaIntegrated() ? next() : c.json({ error: "Not found" }, 404),
);
export default router.openapi(
  createRoute({
    method: "get",
    path: "/overview",
    operationId: "doskaGetOverview",
    tags: ["Doska overview"],
    summary: "Summarize visible unfinished tasks",
    request: { query: pageQuery },
    responses: {
      200: jsonResponse("Working overview", overviewSchema),
      ...memberErrors,
    },
  }),
  async (c) =>
    c.json(await getOverview(c.get("userId"), c.req.valid("query")), 200),
);
