import {
  errorResponse,
  nullableResponseTimestamp,
  pagingNumber,
  responseTimestamp,
  z,
} from "../../openapi";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const userId = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
export const role = z.enum(["participant", "observer"]);
export const projectParams = z.strictObject({ id });
export const invitationParams = z.strictObject({ id, invitationId: id });
export const requestParams = z.strictObject({ id, requestId: id });
export const memberParams = z.strictObject({ id, memberId: id });
export const pageQuery = z.strictObject({
  limit: pagingNumber(1, 100, 50),
  offset: pagingNumber(0, 10_000_000, 0),
});
export const emptyBody = z.strictObject({});
export const inviteBody = z.strictObject({ inviteeUserId: userId, role });
export const respondBody = z.strictObject({ accept: z.boolean() });
export const resolveBody = z.strictObject({ approve: z.boolean() });
export const changeRoleBody = z.strictObject({ expectedRole: role, role });
export const removeBody = z.strictObject({ expectedRole: role });

export const invitationSchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  inviteeUserId: z.string(),
  inviteeName: z.string().nullable(),
  role,
  status: z.enum(["pending", "accepted", "declined", "revoked"]),
  createdAt: responseTimestamp,
  resolvedAt: nullableResponseTimestamp,
});
export const myInvitationSchema = invitationSchema.extend({
  projectArchivedAt: nullableResponseTimestamp,
  projectName: z.string(),
});
export const joinRequestSchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  applicantUserId: z.string(),
  applicantName: z.string().nullable(),
  status: z.enum(["pending", "approved", "rejected", "cancelled"]),
  createdAt: responseTimestamp,
  resolvedAt: nullableResponseTimestamp,
  resolvedBy: z.string().nullable(),
});
export const memberSchema = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  name: z.string(),
  role,
  createdAt: responseTimestamp,
});
export const rosterSchema = z.strictObject({
  owner: z.strictObject({ userId: z.string(), name: z.string() }),
  members: z.array(memberSchema),
});
export const removedSchema = z.strictObject({
  id: z.string(),
  status: z.literal("removed"),
});
export const memberErrors = {
  400: errorResponse("Invalid request"),
  401: errorResponse("Authentication required"),
  403: errorResponse("Operation not permitted"),
  404: errorResponse("Resource unavailable"),
  409: errorResponse("Membership or request state conflict"),
  503: errorResponse("Directory unavailable"),
};
