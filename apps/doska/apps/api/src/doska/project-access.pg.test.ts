import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";
import { projectTable } from "../database/schema";
import {
  getProjectCapabilities,
  listVisibleProjectIds,
  managedProjectCondition,
  visibleProjectCondition,
} from "./project-access";

// This suite uses one connection's TEMP tables only, never application tables.
const connectionString = process.env.DOSKA_TEST_DATABASE_URL;
const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 5_000,
});
const database = drizzle(pool);
const utcNow = "(clock_timestamp() AT TIME ZONE 'utc')";

const readers = [
  {
    name: "getProjectCapabilities",
    read: async (userId: string, now?: Date) =>
      (await getProjectCapabilities(userId, "p1", { database, now }))
        .readContent,
  },
  {
    name: "listVisibleProjectIds",
    read: async (userId: string, now?: Date) =>
      (await listVisibleProjectIds(userId, { database, now })).includes("p1"),
  },
  {
    name: "visibleProjectCondition",
    read: async (userId: string, now?: Date) =>
      (
        await database
          .select({ id: projectTable.id })
          .from(projectTable)
          .where(
            and(
              eq(projectTable.id, "p1"),
              visibleProjectCondition(userId, now),
            ),
          )
      ).length === 1,
  },
  {
    name: "managedProjectCondition",
    read: async (userId: string, now?: Date) =>
      (
        await database
          .select({ id: projectTable.id })
          .from(projectTable)
          .where(
            and(
              eq(projectTable.id, "p1"),
              managedProjectCondition(userId, now),
            ),
          )
      ).length === 1,
  },
];

async function queuedRead(
  read: () => Promise<boolean>,
  update: (client: PoolClient) => Promise<void>,
) {
  const held = await pool.connect();
  const pending = read();
  try {
    const deadline = Date.now() + 5_000;
    while (pool.waitingCount !== 1 && Date.now() < deadline) await delay(1);
    expect(pool.waitingCount).toBe(1);
    await update(held);
  } finally {
    held.release();
  }
  return pending;
}

describe.skipIf(!connectionString)("PostgreSQL project access clock", () => {
  beforeAll(async () => {
    const url = new URL(connectionString!);
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
    await pool.query(`
      CREATE TEMP TABLE project (
        id text, owner_user_id text, department_id text, visibility text
      );
      CREATE TEMP TABLE platform_user_identity (
        user_id text, active boolean, revision bigint, observed_at timestamp,
        valid_until timestamp, primary_department_id text,
        head_department_ids jsonb, subject text
      );
      CREATE TEMP TABLE platform_directory_state (
        id text, observed_at timestamp, valid_until timestamp
      );
      CREATE TEMP TABLE platform_department (
        id text, active boolean, observed_at timestamp, valid_until timestamp,
        head_subjects jsonb
      );
      CREATE TEMP TABLE project_member (project_id text, user_id text, role text);
      CREATE TEMP TABLE platform_department_head (user_id text, department_id text);
    `);
  });

  beforeEach(async () => {
    await pool.query(`
      SET TIME ZONE 'UTC';
      TRUNCATE pg_temp.project, pg_temp.platform_user_identity,
        pg_temp.platform_directory_state, pg_temp.platform_department,
        pg_temp.project_member, pg_temp.platform_department_head;
      INSERT INTO pg_temp.project VALUES
        ('p1', 'u1', 'd1', 'department'), ('unresolved', NULL, NULL, NULL);
      INSERT INTO pg_temp.platform_user_identity VALUES
        ('u1', true, 7, ${utcNow} - interval '1 minute', ${utcNow} + interval '5 minutes', 'd1', '[]', 's1'),
        ('reader', true, 7, ${utcNow} - interval '1 minute', ${utcNow} + interval '5 minutes', 'd1', '[]', 's-reader'),
        ('head', true, 7, ${utcNow} - interval '1 minute', ${utcNow} + interval '5 minutes', 'other', '["d1"]', 's-head');
      INSERT INTO pg_temp.platform_directory_state VALUES
        ('directory', ${utcNow} - interval '1 minute', ${utcNow} + interval '5 minutes');
      INSERT INTO pg_temp.platform_department VALUES
        ('d1', true, ${utcNow} - interval '1 minute', ${utcNow} + interval '5 minutes', '["s-head"]');
      INSERT INTO pg_temp.platform_department_head VALUES ('head', 'd1');
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  it.each(readers)(
    "$name reads renewed identity after pool wait",
    async ({ read }) => {
      expect(await read("u1")).toBe(true);
      const result = await queuedRead(
        () => read("u1"),
        async (held) => {
          await held.query("SELECT pg_sleep(0.05)");
          await held.query(
            `UPDATE pg_temp.platform_user_identity SET observed_at = ${utcNow} WHERE user_id = 'u1'`,
          );
          const row = await held.query(
            "SELECT revision FROM pg_temp.platform_user_identity WHERE user_id = 'u1'",
          );
          expect(row.rows[0].revision).toBe("7");
        },
      );
      expect(result).toBe(true);
      expect(await read("u1")).toBe(true);
    },
  );

  it.each(readers)(
    "$name denies identity that expired while waiting",
    async ({ read }) => {
      const result = await queuedRead(
        () => read("u1"),
        async (held) => {
          await held.query("SELECT pg_sleep(0.05)");
          await held.query(
            `UPDATE pg_temp.platform_user_identity SET valid_until = ${utcNow} - interval '1 millisecond' WHERE user_id = 'u1'`,
          );
        },
      );
      expect(result).toBe(false);
    },
  );

  it.each(readers)(
    "$name preserves an injected Date clock",
    async ({ read }) => {
      const now = new Date("2024-01-15T12:00:00.000Z");
      const observed = new Date(now.getTime() - 60_000).toISOString();
      const validUntil = new Date(now.getTime() + 60_000).toISOString();
      for (const table of [
        "platform_user_identity",
        "platform_department",
        "platform_directory_state",
      ]) {
        await pool.query(
          `UPDATE pg_temp.${table} SET observed_at=$1, valid_until=$2`,
          [observed, validUntil],
        );
      }
      expect(await read("u1", now)).toBe(true);
      expect(await read("u1")).toBe(false);
    },
  );

  const deniedFreshness = [
    ["inactive identity", "platform_user_identity SET active=false"],
    [
      "future identity",
      `platform_user_identity SET observed_at=${utcNow}+interval '2 minutes'`,
    ],
    [
      "expired identity",
      `platform_user_identity SET valid_until=${utcNow}-interval '1 second'`,
    ],
    [
      "future directory stream",
      `platform_directory_state SET observed_at=${utcNow}+interval '2 minutes'`,
    ],
    [
      "expired directory stream",
      `platform_directory_state SET valid_until=${utcNow}-interval '1 second'`,
    ],
    ["inactive department", "platform_department SET active=false"],
    [
      "future department",
      `platform_department SET observed_at=${utcNow}+interval '2 minutes'`,
    ],
    [
      "expired department",
      `platform_department SET valid_until=${utcNow}-interval '1 second'`,
    ],
  ];
  it.each(deniedFreshness)(
    "denies department reader with %s",
    async (_name, update) => {
      expect(
        (await getProjectCapabilities("reader", "p1", { database }))
          .readContent,
      ).toBe(true);
      await pool.query(`UPDATE pg_temp.${update}`);
      expect(
        (await getProjectCapabilities("reader", "p1", { database }))
          .readContent,
      ).toBe(false);
      expect(await listVisibleProjectIds("reader", { database })).toEqual([]);
    },
  );

  it("uses UTC for default time under a different database timezone", async () => {
    await pool.query("SET TIME ZONE 'Pacific/Honolulu'");
    expect(
      (await getProjectCapabilities("reader", "p1", { database })).readContent,
    ).toBe(true);
  });

  it("preserves private project membership roles", async () => {
    await pool.query(
      "UPDATE pg_temp.project SET visibility='private' WHERE id='p1'",
    );
    expect(
      (await getProjectCapabilities("reader", "p1", { database })).readContent,
    ).toBe(false);
    await pool.query(
      "INSERT INTO pg_temp.project_member VALUES ('p1','reader','observer')",
    );
    const observer = await getProjectCapabilities("reader", "p1", { database });
    expect(observer.readContent).toBe(true);
    expect(observer.workOnTasks).toBe(false);
    expect(observer.manageSettings).toBe(false);
    await pool.query("UPDATE pg_temp.project_member SET role='participant'");
    const participant = await getProjectCapabilities("reader", "p1", {
      database,
    });
    expect(participant.readContent).toBe(true);
    expect(participant.workOnTasks).toBe(true);
    expect(participant.manageSettings).toBe(false);
  });

  it("keeps department head management separate from content and requires both head maps", async () => {
    await pool.query(
      "UPDATE pg_temp.project SET visibility='private' WHERE id='p1'",
    );
    const head = await getProjectCapabilities("head", "p1", { database });
    expect(head.readContent).toBe(false);
    expect(head.readManagementMetadata).toBe(true);
    expect(head.transferOwnership).toBe(true);
    expect(await listVisibleProjectIds("head", { database })).toEqual([]);
    await pool.query(
      "UPDATE pg_temp.platform_department SET head_subjects='[]'",
    );
    expect(
      (await getProjectCapabilities("head", "p1", { database }))
        .readManagementMetadata,
    ).toBe(false);
    await pool.query(
      "UPDATE pg_temp.platform_department SET head_subjects='[\"s-head\"]'",
    );
    await pool.query(
      "UPDATE pg_temp.platform_user_identity SET head_department_ids='[]' WHERE user_id='head'",
    );
    expect(
      (await getProjectCapabilities("head", "p1", { database }))
        .readManagementMetadata,
    ).toBe(false);
  });

  it.each([
    "active=false",
    `observed_at=${utcNow}+interval '2 minutes'`,
    `valid_until=${utcNow}-interval '1 second'`,
  ])(
    "denies management through an unfresh department: %s",
    async (condition) => {
      await pool.query(
        "UPDATE pg_temp.project SET visibility='private' WHERE id='p1'",
      );
      expect(
        (await getProjectCapabilities("head", "p1", { database }))
          .transferOwnership,
      ).toBe(true);
      await pool.query(`UPDATE pg_temp.platform_department SET ${condition}`);
      expect(
        (await getProjectCapabilities("head", "p1", { database }))
          .transferOwnership,
      ).toBe(false);
    },
  );

  it("keeps unresolved and nonexistent projects indistinguishable", async () => {
    const unresolved = await getProjectCapabilities("u1", "unresolved", {
      database,
    });
    const missing = await getProjectCapabilities("u1", "missing", { database });
    expect(unresolved).toEqual(missing);
    expect(
      Object.values(unresolved).every((allowed) => allowed === false),
    ).toBe(true);
    expect(await listVisibleProjectIds("u1", { database })).toEqual(["p1"]);
  });
});
