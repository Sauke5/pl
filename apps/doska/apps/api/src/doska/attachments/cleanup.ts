import { cleanupCandidates, markRemoved } from "./metadata-cleanup";
import { getAttachmentStore } from "./runtime";

/** Keep quota reserved until the stored object is physically removed. */
export async function runAttachmentCleanup() {
  if (!process.env.DOSKA_ATTACHMENTS_DIRECTORY) return { degraded: false };
  const store = getAttachmentStore();
  let failed = 0;
  let removed = 0;
  for (const row of await cleanupCandidates()) {
    try {
      if (row.objectKey) await store.remove(row.objectKey);
      await markRemoved(row.id, row.objectKey);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  try {
    await store.pruneTemporary(new Date(Date.now() - 3_600_000));
  } catch {
    failed += 1;
  }
  if (failed)
    console.error("Doska attachment cleanup incomplete", { failed, removed });
  return { degraded: failed > 0, removed, failed };
}
