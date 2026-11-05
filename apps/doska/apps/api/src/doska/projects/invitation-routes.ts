import { apiRouter, createRoute, jsonResponse, z } from "../../openapi";
import { isDoskaIntegrated } from "../mode";
import {
  emptyBody,
  invitationParams,
  invitationSchema,
  inviteBody,
  memberErrors,
  myInvitationSchema,
  pageQuery,
  projectParams,
  respondBody,
} from "./member-schema";
import {
  inviteProject,
  listProjectInvitations,
  listMyInvitations,
  respondInvitation,
  revokeInvitation,
} from "./invitations";
const router = apiRouter();
router.use("*", async (c, next) => {
  if (!isDoskaIntegrated()) return c.json({ error: "Not found" }, 404);
  return next();
});
const routes = router
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/invitations",
      operationId: "doskaInviteProject",
      tags: ["Doska membership"],
      summary: "Invite an employee to the project",
      request: {
        params: projectParams,
        body: {
          required: true,
          content: { "application/json": { schema: inviteBody } },
        },
      },
      responses: {
        201: jsonResponse("Success", invitationSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await inviteProject(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("json"),
        ),
        201,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/projects/{id}/invitations",
      operationId: "doskaListProjectInvitations",
      tags: ["Doska membership"],
      summary: "List pending invitations as project owner",
      request: { params: projectParams, query: pageQuery },
      responses: {
        200: jsonResponse("Success", z.array(invitationSchema)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listProjectInvitations(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("query"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/invitations",
      operationId: "doskaListMyInvitations",
      tags: ["Doska membership"],
      summary: "List invitations addressed to the current employee",
      request: { query: pageQuery },
      responses: {
        200: jsonResponse("Success", z.array(myInvitationSchema)),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await listMyInvitations(c.get("userId"), c.req.valid("query")),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/invitations/{invitationId}/respond",
      operationId: "doskaRespondInvitation",
      tags: ["Doska membership"],
      summary: "Accept or decline an invitation addressed to you",
      request: {
        params: invitationParams,
        body: {
          required: true,
          content: { "application/json": { schema: respondBody } },
        },
      },
      responses: {
        200: jsonResponse("Success", invitationSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await respondInvitation(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").invitationId,
          c.req.valid("json"),
        ),
        200,
      ),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/projects/{id}/invitations/{invitationId}/revoke",
      operationId: "doskaRevokeInvitation",
      tags: ["Doska membership"],
      summary: "Revoke a pending project invitation",
      request: {
        params: invitationParams,
        body: {
          required: true,
          content: { "application/json": { schema: emptyBody } },
        },
      },
      responses: {
        200: jsonResponse("Success", invitationSchema),
        ...memberErrors,
      },
    }),
    async (c) =>
      c.json(
        await revokeInvitation(
          c.get("userId"),
          c.req.valid("param").id,
          c.req.valid("param").invitationId,
        ),
        200,
      ),
  );
export default routes;
