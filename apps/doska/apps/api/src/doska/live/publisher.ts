import { sql } from "drizzle-orm";
import type { Transaction } from "../projects/transaction";
import { encodeLiveChanges, LIVE_CHANNEL, type LiveChange } from "./events";

// Call inside the mutation transaction; PostgreSQL delivers only after commit.
export async function publishLiveChanges(
  tx: Pick<Transaction, "execute">,
  changes: readonly LiveChange[],
) {
  for (const payload of encodeLiveChanges(changes)) {
    await tx.execute(sql`select pg_notify(${LIVE_CHANNEL}, ${payload})`);
  }
}
