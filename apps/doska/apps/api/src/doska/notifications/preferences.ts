import { publishLiveChanges } from "../live/publisher";
import { eq } from "drizzle-orm";
import db from "../../database";
import { userNotificationPreferenceTable } from "../../database/schema";
import { lockDirectory, requireFreshIdentity } from "../projects/transaction";

export async function getNotificationPreferences(userId: string) {
  await requireFreshIdentity(db, userId);
  const [row] = await db
    .select({
      dueDateReminderEnabled:
        userNotificationPreferenceTable.dueDateReminderEnabled,
    })
    .from(userNotificationPreferenceTable)
    .where(eq(userNotificationPreferenceTable.userId, userId));
  return { dueDateReminderEnabled: row?.dueDateReminderEnabled ?? true };
}

export async function updateNotificationPreferences(
  userId: string,
  dueDateReminderEnabled: boolean,
) {
  return db.transaction(async (tx) => {
    await lockDirectory(tx);
    await requireFreshIdentity(tx, userId);
    const [previous] = await tx
      .select({ value: userNotificationPreferenceTable.dueDateReminderEnabled })
      .from(userNotificationPreferenceTable)
      .where(eq(userNotificationPreferenceTable.userId, userId))
      .for("update");
    const [row] = await tx
      .insert(userNotificationPreferenceTable)
      .values({ userId, dueDateReminderEnabled })
      .onConflictDoUpdate({
        target: userNotificationPreferenceTable.userId,
        set: { dueDateReminderEnabled },
      })
      .returning({
        dueDateReminderEnabled:
          userNotificationPreferenceTable.dueDateReminderEnabled,
      });
    if ((previous?.value ?? true) !== row!.dueDateReminderEnabled)
      await publishLiveChanges(tx, [
        {
          kind: "personal",
          userIds: [userId],
          scopes: ["notification-preferences"],
        },
      ]);
    return row!;
  });
}
