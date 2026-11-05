import { apiRouter, createRoute, jsonResponse, z } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import {
  projectListQuery,
  employeeOptionsQuery,
  projectListItem,
  employeeOption,
} from "./discovery-schema";
import { listEmployeeOptions } from "./employee-options";
import { listProjects, listManagedProjects } from "./list";
import { memberErrors } from "./member-schema";
import { managementMetadata, projectParams } from "./schema";

const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const routes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/projects",
      operationId: "doskaListProjects",
      tags: ["Doska projects"],
      summary: "List content-accessible projects",
      request: { query: projectListQuery },
      responses: {
        200: jsonResponse("Accessible projects", z.array(projectListItem)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(await listProjects(c.get("userId"), c.req.valid("query")), 200),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/managed-projects",
      operationId: "doskaListManagedProjects",
      tags: ["Doska projects"],
      summary:
        "List minimal metadata for projects managed as owner or department head",
      request: { query: projectListQuery },
      responses: {
        200: jsonResponse("Managed projects", z.array(managementMetadata)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listManagedProjects(c.get("userId"), c.req.valid("query")),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/employee-options",
      operationId: "doskaProjectEmployeeOptions",
      tags: ["Doska membership"],
      summary:
        "Find eligible employees for an invitation or ownership transfer",
      request: { params: projectParams, query: employeeOptionsQuery },
      responses: {
        200: jsonResponse("Eligible employees", z.array(employeeOption)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listEmployeeOptions(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("query"),
        ),
        200,
      ),
  );
export default routes;
