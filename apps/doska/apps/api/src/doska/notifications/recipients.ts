export type AssignmentRole = "responsible" | "coexecutor";
export type TaskAssignees = {
  readonly userId: string | null;
  readonly coexecutorIds: readonly string[];
};
export type AssignmentRecipient = {
  userId: string;
} & (
  | { kind: "assigned"; previousRole: null; role: AssignmentRole }
  | { kind: "unassigned"; previousRole: AssignmentRole; role: null }
  | {
      kind: "role_changed";
      previousRole: AssignmentRole;
      role: AssignmentRole;
    }
);
function roles(assignees: TaskAssignees): Map<string, AssignmentRole> {
  const result = new Map<string, AssignmentRole>(
    assignees.coexecutorIds.map((id) => [id, "coexecutor"]),
  );
  if (assignees.userId) result.set(assignees.userId, "responsible");
  return result;
}

export function getAssignmentRecipients(
  actorId: string,
  before: TaskAssignees,
  after: TaskAssignees,
): AssignmentRecipient[] {
  const previous = roles(before);
  const current = roles(after);
  const userIds = [...new Set([...previous.keys(), ...current.keys()])].sort();
  const recipients: AssignmentRecipient[] = [];
  for (const userId of userIds) {
    if (userId === actorId) continue;
    const previousRole = previous.get(userId) ?? null;
    const role = current.get(userId) ?? null;
    if (previousRole === role) continue;
    if (previousRole === null && role !== null)
      recipients.push({ userId, kind: "assigned", previousRole, role });
    else if (previousRole !== null && role === null)
      recipients.push({ userId, kind: "unassigned", previousRole, role });
    else if (previousRole !== null && role !== null)
      recipients.push({ userId, kind: "role_changed", previousRole, role });
  }
  return recipients;
}
