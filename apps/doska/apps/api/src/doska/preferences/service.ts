import { publishLiveChanges } from "../live/publisher";
import { eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { doskaUserPreferenceTable } from "../../database/schema";
import { lockDirectory, requireFreshIdentity } from "../projects/transaction";
import { preferenceSchema } from "./schema";
export async function getPreferences(userId: string) {
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    await requireFreshIdentity(tx, userId);
    const [row] = await tx
      .select({ startPage: doskaUserPreferenceTable.startPage })
      .from(doskaUserPreferenceTable)
      .where(eq(doskaUserPreferenceTable.userId, userId));
    await requireFreshIdentity(tx, userId);
    return row ?? { startPage: "my-tasks" as const };
  });
}
export async function updatePreferences(userId: string, input: unknown) {
  const parsed = preferenceSchema.safeParse(input);
  if (!parsed.success)
    throw new HTTPException(400, { message: "Invalid preferences" });
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    await requireFreshIdentity(tx, userId);
    const [previous] = await tx
      .select({ value: doskaUserPreferenceTable.startPage })
      .from(doskaUserPreferenceTable)
      .where(eq(doskaUserPreferenceTable.userId, userId))
      .for("update");
    const [row] = await tx
      .insert(doskaUserPreferenceTable)
      .values({ userId, ...parsed.data })
      .onConflictDoUpdate({
        target: doskaUserPreferenceTable.userId,
        set: {
          startPage: parsed.data.startPage,
          updatedAt: sql`timezone('utc', now())`,
        },
      })
      .returning({ startPage: doskaUserPreferenceTable.startPage });
    await requireFreshIdentity(tx, userId);
    if ((previous?.value ?? "my-tasks") !== row!.startPage)
      await publishLiveChanges(tx, [
        { kind: "personal", userIds: [userId], scopes: ["preferences"] },
      ]);
    return row!;
  });
}
