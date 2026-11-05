import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  doskaResourceLinkTable as links,
  taskTable,
  projectTable,
} from "../../database/schema";
import { readProjectCondition } from "../read-project-condition";
import { backrefsBody } from "./schema";
import { requestDigest } from "./receipts";
import { taskHref } from "./service";
import type { z } from "../../openapi";
// Cursors are short-lived navigation state, not authorization. Restart invalidates them.
const cursorKey = randomBytes(32);
const sign = (value: string) =>
  createHmac("sha256", cursorKey).update(value).digest("base64url");
function decode(
  cursor: string | undefined | null,
  binding: string,
): string | undefined {
  if (!cursor) return undefined;
  try {
    const [payload, mac, ...extra] = cursor.split(".");
    const expected = Buffer.from(sign(payload ?? ""));
    const actual = Buffer.from(mac ?? "");
    if (
      extra.length ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    )
      throw new Error();
    const value = JSON.parse(
      Buffer.from(payload!, "base64url").toString("utf8"),
    );
    if (
      value.binding !== binding ||
      !Number.isSafeInteger(value.expires) ||
      value.expires < Date.now() ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.after)
    )
      throw new Error();
    return value.after;
  } catch {
    throw new HTTPException(400, { message: "Invalid cursor" });
  }
}
export async function resourceBackrefs(
  actorId: string,
  raw: z.input<typeof backrefsBody>,
) {
  const input = backrefsBody.parse(raw);
  const binding = requestDigest({ actorId, ref: input.ref });
  const after = decode(input.cursor, binding);
  const rows = await db
    .select({
      linkId: links.id,
      taskId: taskTable.id,
      projectId: taskTable.projectId,
      title: taskTable.title,
    })
    .from(links)
    .innerJoin(taskTable, eq(taskTable.id, links.taskId))
    .innerJoin(projectTable, eq(projectTable.id, taskTable.projectId))
    .where(
      and(
        eq(links.source, input.ref.source),
        eq(links.objectType, input.ref.type),
        eq(links.objectId, input.ref.id),
        readProjectCondition(actorId, taskTable.projectId),
        isNull(taskTable.archivedAt),
        isNull(projectTable.archivedAt),
        after ? gt(links.id, after) : undefined,
      ),
    )
    .orderBy(asc(links.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  let nextCursor: string | null = null;
  if (rows.length > input.limit) {
    const payload = Buffer.from(
      JSON.stringify({
        binding,
        after: page.at(-1)!.linkId,
        expires: Date.now() + 300000,
      }),
    ).toString("base64url");
    nextCursor = `${payload}.${sign(payload)}`;
  }
  return {
    version: 1 as const,
    items: page.map(({ linkId: _, ...task }) => ({
      ...task,
      href: taskHref(task.projectId, task.taskId),
    })),
    nextCursor,
  };
}
