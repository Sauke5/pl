import {
  errorResponse,
  pagingNumber,
  responseTimestamp,
  z,
} from "../../openapi";
import { memberErrors } from "../projects/member-schema";
import { taskParams } from "../tasks/schema";
import { MAX_ATTACHMENT_BYTES } from "./policy";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const uploadParams = taskParams.extend({ uploadId: id });
export const attachmentParams = taskParams.extend({ attachmentId: id });
export const attachmentQuery = z.strictObject({
  limit: pagingNumber(1, 100, 100),
  offset: pagingNumber(0, 10_000_000, 0),
});
export const reserveBody = z.strictObject({
  filename: z.string().min(1).max(255),
  size: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  clientRequestId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
});
export const uploadResponse = z.strictObject({
  id: z.string(),
  state: z.enum(["reserved", "receiving", "uploaded", "ready", "deleting"]),
  expiresAt: responseTimestamp,
});
export const attachmentResponse = z.strictObject({
  id: z.string(),
  filename: z.string(),
  size: z.number(),
  createdAt: responseTimestamp,
  createdBy: z.string().nullable(),
});
export const attachmentErrors = {
  ...memberErrors,
  413: errorResponse("Attachment limit exceeded"),
  503: errorResponse("Attachment storage unavailable"),
};
