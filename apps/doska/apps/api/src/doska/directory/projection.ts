import { publishLiveChanges } from "../live/publisher";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { eq, sql } from "drizzle-orm";
import db from "../../database";
import {
  platformDepartmentTable,
  platformDirectoryStateTable,
  platformUserIdentityTable,
  userTable,
} from "../../database/schema";
import {
  persistDepartmentTransfers,
  type DepartmentTransfer,
} from "../notifications/transfers";
import { departmentSchema, identitySchema } from "./dto";
import type { DirectoryGeneration } from "./synchronizer";

export class DirectoryProjectionError extends Error {
  constructor(readonly code: "conflict" | "expired" | "invalid_generation") {
    super(`Directory projection: ${code}`);
  }
}

/** Stable subject only: email and display name never establish ownership. */
export function directoryUserId(subject: string) {
  return `pl:${createHash("sha256").update(subject).digest("hex")}`;
}

function validateGeneration(generation: DirectoryGeneration, now: Date) {
  const start = generation.requestStartedAt.getTime();
  const end = generation.leaseUntil.getTime();
  if (
    !Number.isFinite(start) ||
    end !== start + 30_000 ||
    start > now.getTime()
  )
    throw new DirectoryProjectionError("invalid_generation");
  if (end <= now.getTime()) throw new DirectoryProjectionError("expired");
  const departments = generation.departments.map((d) =>
    departmentSchema.parse(d),
  );
  const identities = generation.identities.map((i) => identitySchema.parse(i));
  const ids = new Set(departments.map((d) => d.id));
  if (
    departments.length > 100_000 ||
    identities.length > 100_000 ||
    ids.size !== departments.length ||
    new Set(identities.map((i) => i.sub)).size !== identities.length ||
    identities.some(
      (i) =>
        i.primary_department_id !== null && !ids.has(i.primary_department_id),
    ) ||
    typeof generation.cursor !== "string" ||
    generation.cursor.length > 4096
  )
    throw new DirectoryProjectionError("invalid_generation");
  return { departments, identities };
}

/** CAS fences concurrent consumers; projections, head intersection and lease commit together. */
export class PostgresDirectoryProjection {
  constructor(
    private readonly database: Pick<typeof db, "transaction" | "select"> = db,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async revision(): Promise<number> {
    const [state] = await this.database
      .select({ revision: platformDirectoryStateTable.revision })
      .from(platformDirectoryStateTable)
      .where(eq(platformDirectoryStateTable.id, "directory"));
    return state?.revision ?? 0;
  }

  async publish(
    generation: DirectoryGeneration,
    expectedRevision: number,
  ): Promise<number> {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    )
      throw new DirectoryProjectionError("invalid_generation");
    const { departments, identities } = validateGeneration(
      generation,
      this.clock(),
    );
    return this.database.transaction(async (tx) => {
      await tx
        .insert(platformDirectoryStateTable)
        .values({
          id: "directory",
          revision: 0,
          cursor: "",
          observedAt: new Date(0),
          validUntil: new Date(0),
        })
        .onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(platformDirectoryStateTable)
        .where(eq(platformDirectoryStateTable.id, "directory"))
        .for("update");
      if (!state || state.revision !== expectedRevision)
        throw new DirectoryProjectionError("conflict");

      const previousDepartments = new Map(
        (await tx.select().from(platformDepartmentTable)).map((department) => [
          department.id,
          department,
        ]),
      );
      const affectedHeadSubjects = new Set<string>();
      const affectedDepartments = new Set(
        departments
          .filter((department) => {
            const before = previousDepartments.get(department.id);
            if (
              !isDeepStrictEqual(
                [...(before?.headSubjects ?? [])].sort(),
                [...department.head_subjects].sort(),
              )
            ) {
              for (const subject of [
                ...(before?.headSubjects ?? []),
                ...department.head_subjects,
              ])
                affectedHeadSubjects.add(subject);
            }
            return !before || before.active !== department.active;
          })
          .map((department) => department.id),
      );
      for (const before of previousDepartments.values())
        if (
          before.active &&
          !departments.some((department) => department.id === before.id)
        )
          affectedDepartments.add(before.id);
      // Batching keeps parameter counts below PostgreSQL's protocol limit.
      for (let offset = 0; offset < departments.length; offset += 500) {
        await tx
          .insert(platformDepartmentTable)
          .values(
            departments.slice(offset, offset + 500).map((d) => ({
              id: d.id,
              name: d.name,
              revision: d.revision,
              active: d.active,
              headSubjects: d.head_subjects,
              observedAt: generation.requestStartedAt,
              validUntil: generation.leaseUntil,
            })),
          )
          .onConflictDoUpdate({
            target: platformDepartmentTable.id,
            set: {
              name: sql`excluded.name`,
              revision: sql`excluded.revision`,
              active: sql`excluded.active`,
              sourceAbsent: false,
              headSubjects: sql`excluded.head_subjects`,
            },
            setWhere: sql`${platformDepartmentTable.revision} < excluded.revision OR
              (${platformDepartmentTable.revision} = excluded.revision AND ${platformDepartmentTable.sourceAbsent} = true)`,
          });
      }
      const departmentIds = JSON.stringify(departments.map((d) => d.id));
      await tx.execute(sql`UPDATE platform_department SET observed_at=${generation.requestStartedAt.toISOString()}, valid_until=${generation.leaseUntil.toISOString()}
        WHERE ${departmentIds}::jsonb ? id`);
      await tx.execute(sql`UPDATE platform_department SET source_absent=true, active=false, head_subjects='[]'::jsonb
        WHERE NOT (${departmentIds}::jsonb ? id)`);

      const existing = new Map(
        (await tx.select().from(platformUserIdentityTable)).map((i) => [
          i.subject,
          i,
        ]),
      );
      const changed = identities.filter(
        (i) =>
          !existing.has(i.sub) ||
          existing.get(i.sub)!.revision < i.identity_revision ||
          (existing.get(i.sub)!.sourceAbsent &&
            existing.get(i.sub)!.revision === i.identity_revision),
      );
      const transfers: DepartmentTransfer[] = changed.flatMap((identity) => {
        const before = existing.get(identity.sub);
        if (
          !before ||
          before.revision >= identity.identity_revision ||
          before.primaryDepartmentId === identity.primary_department_id
        )
          return [];
        return [
          {
            userId: before.userId,
            fromDepartmentId: before.primaryDepartmentId,
            toDepartmentId: identity.primary_department_id,
            identityRevision: identity.identity_revision,
          },
        ];
      });
      for (let offset = 0; offset < changed.length; offset += 500) {
        const batch = changed.slice(offset, offset + 500);
        const fresh = batch.filter((i) => !existing.has(i.sub));
        if (fresh.length)
          await tx.insert(userTable).values(
            fresh.map((i) => ({
              id: directoryUserId(i.sub),
              name: i.name,
              email: `${directoryUserId(i.sub).slice(4)}@platform.invalid`,
              emailVerified: false,
              role: "user",
            })),
          );
        await tx
          .insert(platformUserIdentityTable)
          .values(
            batch.map((i) => ({
              userId: existing.get(i.sub)?.userId ?? directoryUserId(i.sub),
              subject: i.sub,
              primaryDepartmentId: i.primary_department_id,
              active: i.state === "active",
              revision: i.identity_revision,
              headDepartmentIds: i.head_department_ids,
              observedAt: new Date(i.observed_at),
              validUntil: new Date(i.valid_until),
            })),
          )
          .onConflictDoUpdate({
            target: platformUserIdentityTable.subject,
            set: {
              primaryDepartmentId: sql`excluded.primary_department_id`,
              sourceAbsent: false,
              active: sql`excluded.active`,
              revision: sql`excluded.revision`,
              headDepartmentIds: sql`excluded.head_department_ids`,
              observedAt: sql`excluded.observed_at`,
              validUntil: sql`excluded.valid_until`,
            },
            setWhere: sql`${platformUserIdentityTable.revision} < excluded.revision OR
              (${platformUserIdentityTable.revision} = excluded.revision AND ${platformUserIdentityTable.sourceAbsent} = true)`,
          });
        await tx.execute(sql`UPDATE "user" AS u SET name=source.name, updated_at=${this.clock().toISOString()}
          FROM jsonb_to_recordset(${JSON.stringify(batch.map((i) => ({ id: existing.get(i.sub)?.userId ?? directoryUserId(i.sub), name: i.name })))}::jsonb) AS source(id text,name text)
          WHERE u.id=source.id`);
      }
      // AD observations renew timestamps without emitting a new rights revision.
      // Refresh only a matching active projection; never copy rights from this path.
      const renewalTime = this.clock().getTime();
      const renewed = identities.filter((identity) => {
        const row = existing.get(identity.sub);
        return (
          row &&
          !row.sourceAbsent &&
          row.active &&
          identity.state === "active" &&
          row.revision === identity.identity_revision &&
          row.primaryDepartmentId === identity.primary_department_id &&
          isDeepStrictEqual(
            [...row.headDepartmentIds].sort(),
            [...identity.head_department_ids].sort(),
          ) &&
          Date.parse(identity.observed_at) > row.observedAt.getTime() &&
          Date.parse(identity.observed_at) <= renewalTime &&
          Date.parse(identity.valid_until) > renewalTime
        );
      });
      for (let offset = 0; offset < renewed.length; offset += 500) {
        const batch = renewed.slice(offset, offset + 500);
        await tx.execute(sql`UPDATE platform_user_identity AS i
          SET observed_at=source.observed_at, valid_until=source.valid_until
          FROM jsonb_to_recordset(${JSON.stringify(
            batch.map((identity) => ({
              subject: identity.sub,
              revision: identity.identity_revision,
              observed_at: identity.observed_at,
              valid_until: identity.valid_until,
            })),
          )}::jsonb) AS source(subject text, revision bigint, observed_at timestamptz, valid_until timestamptz)
          WHERE i.subject=source.subject AND i.revision=source.revision
            AND i.active=true AND i.source_absent=false AND i.observed_at < source.observed_at`);
      }
      const subjects = JSON.stringify(identities.map((i) => i.sub));
      // Keep users, authorship and explicit participation when source records disappear.
      await tx.execute(sql`UPDATE platform_user_identity SET source_absent=true, active=false, head_department_ids='[]'::jsonb
        WHERE NOT (${subjects}::jsonb ? subject)`);
      await tx.execute(sql`DELETE FROM platform_department_head`);
      await tx.execute(sql`INSERT INTO platform_department_head(id,department_id,user_id)
        SELECT md5(d.id || ':' || i.user_id), d.id, i.user_id
        FROM platform_department d CROSS JOIN platform_user_identity i
        WHERE d.active=true AND i.active=true
          AND d.head_subjects ? i.subject AND i.head_department_ids ? d.id`);

      validateGeneration(generation, this.clock());
      const revision = expectedRevision + 1;
      await tx
        .update(platformDirectoryStateTable)
        .set({
          revision,
          cursor: generation.cursor,
          observedAt: generation.requestStartedAt,
          validUntil: generation.leaseUntil,
        })
        .where(eq(platformDirectoryStateTable.id, "directory"));
      await persistDepartmentTransfers(tx, transfers, this.clock());
      const currentSubjects = new Set(
        identities.map((identity) => identity.sub),
      );
      const affectedUsers = new Set(
        changed
          .filter((identity) => {
            const before = existing.get(identity.sub);
            return (
              !before ||
              before.active !== (identity.state === "active") ||
              before.sourceAbsent ||
              before.primaryDepartmentId !== identity.primary_department_id ||
              !isDeepStrictEqual(
                [...before.headDepartmentIds].sort(),
                [...identity.head_department_ids].sort(),
              )
            );
          })
          .map(
            (identity) =>
              existing.get(identity.sub)?.userId ??
              directoryUserId(identity.sub),
          ),
      );
      for (const before of existing.values()) {
        if (
          (before.active && !currentSubjects.has(before.subject)) ||
          affectedHeadSubjects.has(before.subject) ||
          (before.primaryDepartmentId &&
            affectedDepartments.has(before.primaryDepartmentId)) ||
          before.headDepartmentIds.some((id) => affectedDepartments.has(id))
        )
          affectedUsers.add(before.userId);
      }
      await publishLiveChanges(tx, [
        {
          kind: "personal",
          userIds: [...affectedUsers],
          scopes: ["access", "projects"],
        },
      ]);
      validateGeneration(generation, this.clock());
      return revision;
    });
  }
}
