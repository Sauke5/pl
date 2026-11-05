import { isDeepStrictEqual } from "node:util";
import { eq } from "drizzle-orm";
import db from "../../database";
import { platformUserIdentityTable } from "../../database/schema";
import { lockDirectory } from "../projects/transaction";
import { resolveDoskaIdentity } from "../http-identity";
import { PlatformDirectoryClient } from "./client";
import { identitySchema, type DirectoryIdentity } from "./dto";

/** Only freshness may change at the same revision; rights changes arrive through the feed. */
export async function confirmIdentityFreshness(
  subject: string,
  identity: DirectoryIdentity,
) {
  identitySchema.parse(identity);
  if (identity.sub !== subject) return false;
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    const [row] = await tx
      .select()
      .from(platformUserIdentityTable)
      .where(eq(platformUserIdentityTable.subject, subject))
      .for("update");
    const now = Date.now();
    if (
      !row ||
      row.sourceAbsent ||
      !row.active ||
      identity.state !== "active" ||
      row.revision !== identity.identity_revision ||
      row.primaryDepartmentId !== identity.primary_department_id ||
      !isDeepStrictEqual(
        [...row.headDepartmentIds].sort(),
        [...identity.head_department_ids].sort(),
      ) ||
      Date.parse(identity.observed_at) > now ||
      Date.parse(identity.valid_until) <= now ||
      Date.parse(identity.observed_at) < row.observedAt.getTime()
    )
      return false;
    if (Date.parse(identity.observed_at) > row.observedAt.getTime()) {
      await tx
        .update(platformUserIdentityTable)
        .set({
          observedAt: new Date(identity.observed_at),
          validUntil: new Date(identity.valid_until),
        })
        .where(eq(platformUserIdentityTable.subject, subject));
    } else if (Date.parse(identity.valid_until) !== row.validUntil.getTime())
      return false;
    return true;
  });
}

export function createIdentityRefresher(
  source: Pick<PlatformDirectoryClient, "identity">,
  confirm = confirmIdentityFreshness,
  resolve = resolveDoskaIdentity,
) {
  const pending = new Map<string, ReturnType<typeof resolveDoskaIdentity>>();
  return (subject: string) => {
    const existing = pending.get(subject);
    if (existing) return existing;
    if (pending.size >= 32) return Promise.resolve(null);
    const request = (async () => {
      try {
        const identity = await source.identity(subject);
        if (!(await confirm(subject, identity))) return null;
        return await resolve(subject);
      } catch {
        return null;
      } finally {
        pending.delete(subject);
      }
    })();
    pending.set(subject, request);
    return request;
  };
}

let refresh: ReturnType<typeof createIdentityRefresher> | undefined;
export async function refreshRequestIdentity(subject: string) {
  const machineTokenFile = process.env.DOSKA_DIRECTORY_TOKEN_FILE;
  if (!machineTokenFile || !process.env.DOSKA_MODULE_INSTANCE_ID || !process.env.DOSKA_DIRECTORY_ORIGIN) return null;
  refresh ??= createIdentityRefresher(
    new PlatformDirectoryClient({
      origin: process.env.DOSKA_DIRECTORY_ORIGIN ?? "",
      instanceID: process.env.DOSKA_MODULE_INSTANCE_ID,
      machineTokenFile,
    }),
  );
  return refresh(subject);
}
