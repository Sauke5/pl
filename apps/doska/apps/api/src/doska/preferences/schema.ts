import { z } from "../../openapi";
export const preferenceSchema = z.strictObject({
  startPage: z.enum([
    "my-tasks",
    "projects",
    "search",
    "invitations",
    "management",
  ]),
});
