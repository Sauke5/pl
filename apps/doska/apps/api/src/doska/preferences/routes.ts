import { apiRouter, createRoute, jsonResponse } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { memberErrors } from "../projects/member-schema";
import { preferenceSchema } from "./schema";
import { getPreferences, updatePreferences } from "./service";
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
export default router
  .openapi(
    createRoute({
      method: "get",
      path: "/preferences",
      operationId: "doskaGetPreferences",
      tags: ["Doska preferences"],
      summary: "Read personal preferences",
      responses: {
        200: jsonResponse("Preferences", preferenceSchema),
        ...memberErrors,
      },
    }),
    async (c) => c.json(await getPreferences(c.get("userId")), 200),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/preferences",
      operationId: "doskaUpdatePreferences",
      tags: ["Doska preferences"],
      summary: "Update personal preferences",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: preferenceSchema } },
        },
      },
      responses: {
        200: jsonResponse("Preferences", preferenceSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await updatePreferences(c.get("userId"), c.req.valid("json")),
        200,
      ),
  );
