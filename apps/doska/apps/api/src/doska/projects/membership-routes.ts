import { apiRouter, createRoute, jsonResponse, z } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import {
  changeRoleBody,
  emptyBody,
  joinRequestSchema,
  memberErrors,
  memberParams,
  memberSchema,
  pageQuery,
  projectParams,
  removeBody,
  removedSchema,
  requestParams,
  resolveBody,
  rosterSchema,
} from "./member-schema";
import {
  requestProjectJoin,
  listProjectJoinRequests,
  resolveProjectJoin,
  cancelProjectJoin,
  listProjectMembers,
  changeProjectMember,
  removeProjectMember,
} from "./memberships";
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const routes = router
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/join-requests",
      operationId: "doskaRequestProjectJoin",
      tags: ["Doska membership"],
      summary: "Request participation in an open project of your department",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: emptyBody } },
        },
      },
      responses: {
        201: jsonResponse("Success", joinRequestSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await requestProjectJoin(c.get("userId"), c.req.valid("param").id),
        201,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/join-requests",
      operationId: "doskaListJoinRequests",
      tags: ["Doska membership"],
      summary:
        "List pending requests as owner, or own requests as content reader",
      request: { params: projectParams, query: pageQuery },
      responses: {
        200: jsonResponse("Success", z.array(joinRequestSchema)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listProjectJoinRequests(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("query"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/join-requests/{requestId}/resolve",
      operationId: "doskaResolveJoinRequest",
      tags: ["Doska membership"],
      summary: "Approve or reject a pending request",
      request: {
        params: requestParams,
        body: {
          required: true,
          content: { "application/json": { schema: resolveBody } },
        },
      },
      responses: {
        200: jsonResponse("Success", joinRequestSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await resolveProjectJoin(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").requestId,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/join-requests/{requestId}/cancel",
      operationId: "doskaCancelJoinRequest",
      tags: ["Doska membership"],
      summary: "Cancel your own pending request",
      request: {
        params: requestParams,
        body: {
          required: true,
          content: { "application/json": { schema: emptyBody } },
        },
      },
      responses: {
        200: jsonResponse("Success", joinRequestSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await cancelProjectJoin(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").requestId,
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/members",
      operationId: "doskaProjectMembers",
      tags: ["Doska membership"],
      summary: "Read the roster of an accessible project",
      request: { params: projectParams, query: pageQuery },
      responses: {
        200: jsonResponse("Success", rosterSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listProjectMembers(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("query"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/projects/{id}/members/{memberId}",
      operationId: "doskaChangeMemberRole",
      tags: ["Doska membership"],
      summary: "Change a participant or observer role as project owner",
      request: {
        params: memberParams,
        body: {
          required: true,
          content: { "application/json": { schema: changeRoleBody } },
        },
      },
      responses: {
        200: jsonResponse("Success", memberSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await changeProjectMember(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").memberId,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/projects/{id}/members/{memberId}",
      operationId: "doskaRemoveMember",
      tags: ["Doska membership"],
      summary: "Remove an explicit participant as project owner",
      request: {
        params: memberParams,
        body: {
          required: true,
          content: { "application/json": { schema: removeBody } },
        },
      },
      responses: {
        200: jsonResponse("Success", removedSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await removeProjectMember(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").memberId,
          c.req.valid("json"),
        ),
        200,
      ),
  );
export default routes;
