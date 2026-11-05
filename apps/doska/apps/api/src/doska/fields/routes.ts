import { apiRouter, createRoute, jsonResponse } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import { memberErrors } from "../projects/member-schema";
import { projectParams } from "../projects/schema";
import {
  listFields,
  createField,
  updateField,
  reorderFields,
  updateFieldSettings,
} from "./service";
import {
  fieldsResponse,
  fieldParams,
  createFieldBody,
  updateFieldBody,
  reorderFieldsBody,
  fieldSettingsBody,
} from "./schema";
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const routes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/fields",
      operationId: "doskaListFields",
      tags: ["Doska fields"],
      summary: "doskaListFields",
      request: { params: projectParams },
      responses: {
        200: jsonResponse("Project fields", fieldsResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(await listFields(c.get("userId"), c.req.valid("param").id), 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/fields",
      operationId: "doskaCreateField",
      tags: ["Doska fields"],
      summary: "doskaCreateField",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: createFieldBody } },
        },
      },
      responses: {
        201: jsonResponse("Project fields", fieldsResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await createField(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/fields/reorder",
      operationId: "doskaReorderFields",
      tags: ["Doska fields"],
      summary: "doskaReorderFields",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: reorderFieldsBody } },
        },
      },
      responses: {
        200: jsonResponse("Project fields", fieldsResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await reorderFields(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/projects/{id}/fields/settings",
      operationId: "doskaUpdateFieldSettings",
      tags: ["Doska fields"],
      summary: "doskaUpdateFieldSettings",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: fieldSettingsBody } },
        },
      },
      responses: {
        200: jsonResponse("Project fields", fieldsResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await updateFieldSettings(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/projects/{id}/fields/{fieldId}",
      operationId: "doskaUpdateField",
      tags: ["Doska fields"],
      summary: "doskaUpdateField",
      request: {
        params: fieldParams,
        body: {
          required: true,
          content: { "application/json": { schema: updateFieldBody } },
        },
      },
      responses: {
        200: jsonResponse("Project fields", fieldsResponse),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await updateField(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").fieldId,
          c.req.valid("json"),
        ),
        200,
      ),
  );
export default routes;
