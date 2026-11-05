import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { doskaResourceRequestTable } from "../../database/schema";
import type { Transaction } from "../tasks/transaction";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function requestDigest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
// Call after the project lock and current ACL checks. Receipts survive task deletion.
export async function readReceipt(
  tx: Transaction,
  actorId: string,
  projectId: string,
  clientRequestId: string,
  digest: string,
) {
  const [receipt] = await tx
    .select()
    .from(doskaResourceRequestTable)
    .where(
      and(
        eq(doskaResourceRequestTable.actorId, actorId),
        eq(doskaResourceRequestTable.projectId, projectId),
        eq(doskaResourceRequestTable.clientRequestId, clientRequestId),
      ),
    );
  if (receipt && receipt.digest !== digest)
    throw new HTTPException(409, { message: "idempotency_conflict" });
  return receipt?.result;
}
export async function saveReceipt(
  tx: Transaction,
  actorId: string,
  projectId: string,
  clientRequestId: string,
  digest: string,
  result: typeof doskaResourceRequestTable.$inferInsert.result,
) {
  await tx
    .insert(doskaResourceRequestTable)
    .values({ actorId, projectId, clientRequestId, digest, result });
  return result;
}
