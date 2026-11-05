import { TaskImportError } from "./task-import-error";
import { client, resolveApiBaseUrl } from "@kaneo/libs";
import type { InferRequestType, InferResponseType } from "hono/client";
import type {
  CustomField,
  ProjectFields,
  RequiredTaskField,
} from "./custom-fields";

const doska = client.doska;
const project = doska.projects[":id"];
const task = project.tasks[":taskId"];
const comments = task.comments;
const comment = comments[":commentId"];
const checklists = task.checklists;
const checklist = checklists[":checklistId"];
const checklistItem = checklist.items[":itemId"];
export type TaskAttachment = {
  id: string;
  filename: string;
  size: number;
  createdAt: string;
  createdBy: string | null;
};
export type TaskComment = InferResponseType<typeof comments.$get, 200>[number];
export type Checklists = InferResponseType<typeof checklists.$get, 200>;

const createColumnRequest = project.columns.$post;
const updateColumnRequest = project.columns[":columnId"].$patch;
const reorderColumnsRequest = project.columns.reorder.$post;
const deleteColumnRequest = project.columns[":columnId"].$delete;
const updateProjectRequest = project.$patch;
const archiveProjectRequest = project.archive.$post;
const transferOwnershipRequest = project.owner.$post;
const createInvitationRequest = project.invitations.$post;
const respondInvitationRequest =
  project.invitations[":invitationId"].respond.$post;
const revokeInvitationRequest =
  project.invitations[":invitationId"].revoke.$post;
const createJoinRequestRequest = project["join-requests"].$post;
const resolveJoinRequestRequest =
  project["join-requests"][":requestId"].resolve.$post;
const cancelJoinRequestRequest =
  project["join-requests"][":requestId"].cancel.$post;
const changeMemberRequest = project.members[":memberId"].$patch;
const removeMemberRequest = project.members[":memberId"].$delete;
const getManagementRequest = project.management.$get;
const listManagedProjectsRequest = doska["managed-projects"].$get;
const listMyInvitationsRequest = doska.invitations.$get;
const listProjectInvitationsRequest = project.invitations.$get;
const listJoinRequestsRequest = project["join-requests"].$get;
const employeeOptionsRequest = project["employee-options"].$get;
const listMemberPageRequest = project.members.$get;
export type Context = InferResponseType<typeof doska.context.$get, 200>;
export type Task = InferResponseType<typeof task.$get, 200>;
export type Column = InferResponseType<
  typeof project.columns.$get,
  200
>[number];
export type Project = InferResponseType<typeof project.$get, 200>;
export type Capabilities = InferResponseType<typeof project.access.$get, 200>;
export type MemberRoster = InferResponseType<typeof project.members.$get, 200>;
export type HistoryItem = InferResponseType<
  typeof task.history.$get,
  200
>[number];
export type MyTask = InferResponseType<
  (typeof doska)["my-tasks"]["$get"],
  200
>[number];
export type Relation = InferResponseType<
  typeof task.relations.$get,
  200
>[number];
export type CreateTaskInput = InferRequestType<
  typeof project.tasks.$post
>["json"];
export type UpdateTaskInput = InferRequestType<typeof task.$patch>["json"];
type CreateProjectInput = InferRequestType<typeof doska.projects.$post>["json"];
type ArchiveTaskInput = InferRequestType<typeof task.archive.$post>["json"];
type DeleteTaskInput = InferRequestType<typeof task.$delete>["json"];
export type Page = { limit?: number; offset?: number };
type ListQuery = Page & { archived?: boolean; search?: string };
export type TaskSearchQuery = Page & {
  resourceId?: string;
  sourceKind?: "platform" | "netbox";
  labelName?: string;
  customFieldId?: string;
  customFieldValue?: string;
  q?: string;
  projectId?: string;
  assigneeId?: string;
  coexecutorId?: string;
  state?: "planned" | "active" | "completed";
  priority?: "no-priority" | "low" | "medium" | "high" | "urgent";
  dueFrom?: string;
  dueTo?: string;
  open?: boolean;
  upcoming?: boolean;
  unassigned?: boolean;
  overdue?: boolean;
  archived?: boolean;
};
let csrfToken: string | undefined;
let contextGeneration = 0;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
async function read<T>(request: Promise<Response>): Promise<T> {
  const response = await request;
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object") {
        if ("message" in body && typeof body.message === "string")
          message = body.message;
        else if ("error" in body && typeof body.error === "string")
          message = body.error;
      }
    } catch {
      /* Preserve HTTP status when a proxy returns a non-JSON error. */
    }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}
function pageQuery(page: Page = {}) {
  return { limit: String(page.limit ?? 50), offset: String(page.offset ?? 0) };
}
function listQuery(query: ListQuery = {}) {
  return {
    ...pageQuery(query),
    archived: query.archived ? ("true" as const) : ("false" as const),
  };
}
export async function mutationOptions() {
  if (!csrfToken) await api.getContext();
  return { headers: { "X-CSRF-Token": csrfToken! } };
}

const templates = doska.templates;
export type DoskaTemplate = InferResponseType<
  (typeof templates)[":id"]["$get"],
  200
>;
export type TemplatePreview = InferResponseType<
  (typeof project)["template-preview"]["$post"],
  200
>;
export type SaveTemplateInput = InferRequestType<
  typeof templates.$post
>["json"];
export type CreateTemplateProjectInput = InferRequestType<
  (typeof templates)[":id"]["projects"]["$post"]
>["json"];
const notifications = doska.notifications;
export type DoskaNotification = InferResponseType<
  typeof notifications.$get,
  200
>["items"][number];
function attachmentTaskUrl(id: string, taskId: string) {
  const base = resolveApiBaseUrl(
    import.meta.env.VITE_API_URL,
    import.meta.env.BASE_URL,
    import.meta.env.VITE_DOSKA_MODE,
  );
  return (
    base +
    "/doska/projects/" +
    encodeURIComponent(id) +
    "/tasks/" +
    encodeURIComponent(taskId)
  );
}

export const api = {
  listAttachments(id: string, taskId: string, page: Page = {}) {
    return read<TaskAttachment[]>(
      task.attachments.$get({ param: { id, taskId }, query: pageQuery(page) }),
    );
  },
  attachmentDownloadUrl(id: string, taskId: string, attachmentId: string) {
    return (
      attachmentTaskUrl(id, taskId) +
      "/attachments/" +
      encodeURIComponent(attachmentId) +
      "/content"
    );
  },
  async deleteAttachment(id: string, taskId: string, attachmentId: string) {
    const response = await task.attachments[":attachmentId"].$delete(
      { param: { id, taskId, attachmentId }, json: {} },
      await mutationOptions(),
    );
    if (!response.ok) await read(Promise.resolve(response));
  },
  async uploadAttachment(
    id: string,
    taskId: string,
    file: File,
    options: {
      signal: AbortSignal;
      onProgress: (percent: number) => void;
      clientRequestId: string;
    },
  ): Promise<TaskAttachment> {
    const { signal, onProgress } = options;
    signal.throwIfAborted();
    if (!file.size || file.size > 25 * 1024 * 1024)
      throw new ApiError(413, "attachment_file_too_large");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    signal.throwIfAborted();
    const uploads = task["attachment-uploads"];
    const headers = await mutationOptions();
    const reserve = (clientRequestId: string) =>
      read<{ id: string; state: string }>(
        uploads.$post(
          {
            param: { id, taskId },
            json: {
              filename: file.name,
              size: file.size,
              sha256,
              clientRequestId,
            },
          },
          headers,
        ),
      );
    let ticket;
    try {
      ticket = await reserve(options.clientRequestId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
      ticket = await reserve(crypto.randomUUID());
    }
    // An interrupted attempt remains charged until disk cleanup. A new attempt needs its own ticket.
    if (ticket.state === "deleting")
      ticket = await reserve(crypto.randomUUID());
    const param = { id, taskId, uploadId: ticket.id };
    try {
      signal.throwIfAborted();
      if (ticket.state !== "uploaded" && ticket.state !== "ready") {
        const url =
          attachmentTaskUrl(id, taskId) +
          "/attachment-uploads/" +
          encodeURIComponent(ticket.id) +
          "/content";
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const abort = () => xhr.abort();
          const done = () => signal.removeEventListener("abort", abort);
          xhr.open("PUT", url);
          xhr.withCredentials = true;
          xhr.timeout = 125_000;
          xhr.setRequestHeader("Content-Type", "application/octet-stream");
          xhr.setRequestHeader("X-CSRF-Token", headers.headers["X-CSRF-Token"]);
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable)
              onProgress(Math.round((event.loaded / event.total) * 100));
          };
          xhr.onload = () => {
            done();
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new ApiError(xhr.status, "attachment_upload_failed"));
          };
          xhr.onerror = xhr.ontimeout = () => {
            done();
            reject(new ApiError(503, "attachment_upload_failed"));
          };
          xhr.onabort = () => {
            done();
            reject(new DOMException("Upload cancelled", "AbortError"));
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) {
            done();
            reject(new DOMException("Upload cancelled", "AbortError"));
            return;
          }
          xhr.send(file);
        });
      }
      signal.throwIfAborted();
      return await read<TaskAttachment>(
        uploads[":uploadId"].finalize.$post({ param, json: {} }, headers),
      );
    } catch (error) {
      if (signal.aborted)
        await uploads[":uploadId"]
          .$delete({ param, json: {} }, headers)
          .catch(() => {});
      throw error;
    }
  },
  preferences() {
    return read<InferResponseType<typeof doska.preferences.$get, 200>>(
      doska.preferences.$get(),
    );
  },
  async updatePreferences(json: {
    startPage:
      | "my-tasks"
      | "projects"
      | "search"
      | "invitations"
      | "management";
  }) {
    return read<InferResponseType<typeof doska.preferences.$patch, 200>>(
      doska.preferences.$patch({ json }, await mutationOptions()),
    );
  },
  listNotifications(query: { limit?: number; cursor?: string } = {}) {
    return read<InferResponseType<typeof notifications.$get, 200>>(
      notifications.$get({
        query: {
          limit: String(query.limit ?? 30),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        },
      }),
    );
  },
  notificationPreferences() {
    return read<InferResponseType<typeof notifications.preferences.$get, 200>>(
      notifications.preferences.$get(),
    );
  },
  async updateNotificationPreferences(json: {
    dueDateReminderEnabled: boolean;
  }) {
    return read<
      InferResponseType<typeof notifications.preferences.$patch, 200>
    >(notifications.preferences.$patch({ json }, await mutationOptions()));
  },
  notificationUnreadCount() {
    return read<
      InferResponseType<(typeof notifications)["unread-count"]["$get"], 200>
    >(notifications["unread-count"].$get());
  },
  async markNotificationRead(id: string) {
    return read<
      InferResponseType<(typeof notifications)[":id"]["read"]["$patch"], 200>
    >(
      notifications[":id"].read.$patch(
        { param: { id }, json: {} },
        await mutationOptions(),
      ),
    );
  },
  async readAllNotifications() {
    return read<
      InferResponseType<(typeof notifications)["read-all"]["$post"], 200>
    >(notifications["read-all"].$post({ json: {} }, await mutationOptions()));
  },

  listTemplates(page = 1) {
    return read<InferResponseType<typeof templates.$get, 200>>(
      templates.$get({ query: { page: String(page) } }),
    );
  },
  readTemplate(id: string) {
    return read<DoskaTemplate>(templates[":id"].$get({ param: { id } }));
  },
  async saveTemplate(body: SaveTemplateInput) {
    return read<InferResponseType<typeof templates.$post, 201>>(
      templates.$post({ json: body }, await mutationOptions()),
    );
  },
  async createTemplateProject(id: string, body: CreateTemplateProjectInput) {
    return read<
      InferResponseType<(typeof templates)[":id"]["projects"]["$post"], 201>
    >(
      templates[":id"].projects.$post(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  getTemplateSelection(id: string) {
    return read<
      InferResponseType<(typeof project)["template-selection"]["$get"], 200>
    >(project["template-selection"].$get({ param: { id } }));
  },
  async setTemplateSelection(
    id: string,
    taskId: string,
    body: { selected: boolean; expectedRevision: number },
  ) {
    return read<
      InferResponseType<
        (typeof project)["template-selection"][":taskId"]["$patch"],
        200
      >
    >(
      project["template-selection"][":taskId"].$patch(
        { param: { id, taskId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async previewTemplate(id: string) {
    return read<TemplatePreview>(
      project["template-preview"].$post(
        { param: { id }, json: {} },
        await mutationOptions(),
      ),
    );
  },

  listComments(id: string, taskId: string, page: Page = {}) {
    return read<TaskComment[]>(
      comments.$get({ param: { id, taskId }, query: pageQuery(page) }),
    );
  },
  getChecklists(id: string, taskId: string) {
    return read<Checklists>(checklists.$get({ param: { id, taskId } }));
  },
  async createComment(
    id: string,
    taskId: string,
    body: InferRequestType<typeof comments.$post>["json"],
  ) {
    return read<TaskComment>(
      comments.$post(
        { param: { id, taskId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async updateComment(
    id: string,
    taskId: string,
    commentId: string,
    body: InferRequestType<typeof comment.$patch>["json"],
  ) {
    return read<TaskComment>(
      comment.$patch(
        { param: { id, taskId, commentId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async deleteComment(
    id: string,
    taskId: string,
    commentId: string,
    body: InferRequestType<typeof comment.$delete>["json"],
  ) {
    return read<TaskComment>(
      comment.$delete(
        { param: { id, taskId, commentId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async createChecklist(
    id: string,
    taskId: string,
    body: InferRequestType<typeof checklists.$post>["json"],
  ) {
    return read<Checklists>(
      checklists.$post(
        { param: { id, taskId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async updateChecklist(
    id: string,
    taskId: string,
    checklistId: string,
    body: InferRequestType<typeof checklist.$patch>["json"],
  ) {
    return read<Checklists>(
      checklist.$patch(
        { param: { id, taskId, checklistId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async deleteChecklist(
    id: string,
    taskId: string,
    checklistId: string,
    body: InferRequestType<typeof checklist.$delete>["json"],
  ) {
    return read<Checklists>(
      checklist.$delete(
        { param: { id, taskId, checklistId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async reorderChecklists(
    id: string,
    taskId: string,
    body: InferRequestType<typeof checklists.order.$put>["json"],
  ) {
    return read<Checklists>(
      checklists.order.$put(
        { param: { id, taskId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async createChecklistItem(
    id: string,
    taskId: string,
    checklistId: string,
    body: InferRequestType<typeof checklist.items.$post>["json"],
  ) {
    return read<Checklists>(
      checklist.items.$post(
        { param: { id, taskId, checklistId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async updateChecklistItem(
    id: string,
    taskId: string,
    checklistId: string,
    itemId: string,
    body: InferRequestType<typeof checklistItem.$patch>["json"],
  ) {
    return read<Checklists>(
      checklistItem.$patch(
        { param: { id, taskId, checklistId, itemId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async deleteChecklistItem(
    id: string,
    taskId: string,
    checklistId: string,
    itemId: string,
    body: InferRequestType<typeof checklistItem.$delete>["json"],
  ) {
    return read<Checklists>(
      checklistItem.$delete(
        { param: { id, taskId, checklistId, itemId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async reorderChecklistItems(
    id: string,
    taskId: string,
    checklistId: string,
    body: InferRequestType<typeof checklist.items.order.$put>["json"],
  ) {
    return read<Checklists>(
      checklist.items.order.$put(
        { param: { id, taskId, checklistId }, json: body },
        await mutationOptions(),
      ),
    );
  },

  async getContext(options: { signal?: AbortSignal } = {}): Promise<Context> {
    const generation = ++contextGeneration;
    try {
      const context = await read<Context>(
        doska.context.$get(undefined, { init: { signal: options.signal } }),
      );
      options.signal?.throwIfAborted();
      if (generation === contextGeneration) csrfToken = context.csrfToken;
      return context;
    } catch (error) {
      if (generation === contextGeneration) csrfToken = undefined;
      throw error;
    }
  },
  listProjects(query: ListQuery = {}) {
    return read<InferResponseType<typeof doska.projects.$get, 200>>(
      doska.projects.$get({
        query: {
          ...listQuery(query),
          ...(query.search ? { q: query.search } : {}),
        },
      }),
    );
  },
  overview(query: Page = {}) {
    return read<InferResponseType<typeof doska.overview.$get, 200>>(
      doska.overview.$get({ query: pageQuery(query) }),
    );
  },
  searchTasks(query: TaskSearchQuery = {}) {
    const {
      limit,
      offset,
      archived,
      unassigned,
      overdue,
      open,
      upcoming,
      ...filters
    } = query;
    return read<MyTask[]>(
      doska["task-search"].$get({
        query: {
          ...pageQuery({ limit, offset }),
          ...filters,
          archived: archived ? "true" : "false",
          ...(open === undefined
            ? {}
            : { open: open ? ("true" as const) : ("false" as const) }),
          ...(upcoming === undefined
            ? {}
            : { upcoming: upcoming ? ("true" as const) : ("false" as const) }),
          ...(unassigned === undefined
            ? {}
            : {
                unassigned: unassigned ? ("true" as const) : ("false" as const),
              }),
          ...(overdue === undefined
            ? {}
            : { overdue: overdue ? ("true" as const) : ("false" as const) }),
        },
      }),
    );
  },
  listMyTasks(query: ListQuery = {}) {
    return read<MyTask[]>(doska["my-tasks"].$get({ query: listQuery(query) }));
  },
  async createProject(body: CreateProjectInput) {
    return read<InferResponseType<typeof doska.projects.$post, 201>>(
      doska.projects.$post({ json: body }, await mutationOptions()),
    );
  },
  getProject(id: string) {
    return read<Project>(project.$get({ param: { id } }));
  },
  getAccess(id: string, options: { signal?: AbortSignal } = {}) {
    return read<Capabilities>(
      project.access.$get(
        { param: { id } },
        { init: { signal: options.signal } },
      ),
    );
  },
  listProjectLabels(
    id: string,
    query: { q?: string; limit?: number; offset?: number } = {},
  ) {
    return read<{ name: string; color: string }[]>(
      project.labels.$get({
        param: { id },
        query: {
          ...query,
          limit: query.limit?.toString(),
          offset: query.offset?.toString(),
        },
      }),
    );
  },
  getProjectFields(id: string) {
    return read<ProjectFields>(project.fields.$get({ param: { id } }));
  },
  async createProjectField(
    id: string,
    body: {
      expectedRevision: number;
      name: string;
      type: CustomField["type"];
      required?: boolean;
      defaultValue?: string | null;
      options?: string[] | null;
    },
  ) {
    return read<unknown>(
      project.fields.$post(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async updateProjectField(
    id: string,
    fieldId: string,
    body: {
      expectedRevision: number;
      name?: string;
      required?: boolean;
      defaultValue?: string | null;
      options?: string[] | null;
      archived?: boolean;
    },
  ) {
    return read<unknown>(
      project.fields[":fieldId"].$patch(
        { param: { id, fieldId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async reorderProjectFields(
    id: string,
    body: { expectedRevision: number; fieldIds: string[] },
  ) {
    return read<unknown>(
      project.fields.reorder.$post(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async setRequiredTaskFields(
    id: string,
    body: { expectedRevision: number; requiredTaskFields: RequiredTaskField[] },
  ) {
    return read<unknown>(
      project.fields.settings.$patch(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  listColumns(id: string) {
    return read<Column[]>(project.columns.$get({ param: { id } }));
  },
  listTasks(id: string, query: ListQuery & { parentTaskId?: string } = {}) {
    return read<Task[]>(
      project.tasks.$get({
        param: { id },
        query: { ...listQuery(query), parentTaskId: query.parentTaskId },
      }),
    );
  },
  getTask(id: string, taskId: string) {
    return read<Task>(task.$get({ param: { id, taskId } }));
  },
  async listMembers(id: string): Promise<MemberRoster> {
    const roster = await read<MemberRoster>(
      project.members.$get({ param: { id }, query: pageQuery({ limit: 100 }) }),
    );
    let count = roster.members.length;
    for (let offset = 100; count === 100; offset += 100) {
      const page = await read<MemberRoster>(
        project.members.$get({
          param: { id },
          query: pageQuery({ limit: 100, offset }),
        }),
      );
      count = page.members.length;
      roster.members.push(...page.members);
    }
    roster.members = Array.from(
      new Map(roster.members.map((member) => [member.userId, member])).values(),
    );
    return roster;
  },
  taskHistory(id: string, taskId: string, page: Page = {}) {
    return read<HistoryItem[]>(
      task.history.$get({ param: { id, taskId }, query: pageQuery(page) }),
    );
  },
  async importTasks(
    id: string,
    body: { clientRequestId: string; tasks: CreateTaskInput[] },
  ) {
    const response = await project["task-imports"].$post(
      { param: { id }, json: body },
      await mutationOptions(),
    );
    if (!response.ok) {
      const data: unknown = await response.json().catch(() => null);
      const record =
        data && typeof data === "object"
          ? (data as Record<string, unknown>)
          : {};
      const issues = Array.isArray(record.issues)
        ? record.issues.filter(
            (issue): issue is { path: string; message: string } =>
              Boolean(
                issue &&
                typeof issue === "object" &&
                typeof issue.path === "string" &&
                typeof issue.message === "string",
              ),
          )
        : [];
      throw new TaskImportError(
        response.status,
        typeof record.code === "string" ? record.code : "IMPORT_FAILED",
        issues,
      );
    }
    return response.json() as Promise<{
      taskIds: string[];
      imported: number;
      replayed: boolean;
    }>;
  },
  async createTask(id: string, body: CreateTaskInput) {
    return read<Task>(
      project.tasks.$post(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async updateTask(id: string, taskId: string, body: UpdateTaskInput) {
    return read<Task>(
      task.$patch(
        { param: { id, taskId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async archiveTask(id: string, taskId: string, body: ArchiveTaskInput) {
    return read<Task>(
      task.archive.$post(
        { param: { id, taskId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async deleteTask(id: string, taskId: string, body: DeleteTaskInput) {
    return read<InferResponseType<typeof task.$delete, 200>>(
      task.$delete(
        { param: { id, taskId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  getRelations(id: string, taskId: string, page: Page = {}) {
    return read<Relation[]>(
      task.relations.$get({
        param: { id, taskId },
        query: pageQuery(page),
      }),
    );
  },
  async createRelation(
    id: string,
    taskId: string,
    body: {
      expectedRevision: number;
      targetTaskId: string;
      type: "related" | "blocks" | "duplicate";
    },
  ) {
    return read<Relation>(
      task.relations.$post(
        { param: { id, taskId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async deleteRelation(
    id: string,
    taskId: string,
    relationId: string,
    body: { expectedRevision: number },
  ) {
    return read<{ id: string }>(
      task.relations[":relationId"].$delete(
        { param: { id, taskId, relationId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async createColumn(
    id: string,
    body: InferRequestType<typeof createColumnRequest>["json"],
  ) {
    return read<InferResponseType<typeof createColumnRequest, 201>>(
      createColumnRequest(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async updateColumn(
    id: string,
    columnId: string,
    body: InferRequestType<typeof updateColumnRequest>["json"],
  ) {
    return read<InferResponseType<typeof updateColumnRequest, 200>>(
      updateColumnRequest(
        { param: { id, columnId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async reorderColumns(
    id: string,
    body: InferRequestType<typeof reorderColumnsRequest>["json"],
  ) {
    return read<InferResponseType<typeof reorderColumnsRequest, 200>>(
      reorderColumnsRequest(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async deleteColumn(
    id: string,
    columnId: string,
    body: InferRequestType<typeof deleteColumnRequest>["json"],
  ) {
    return read<InferResponseType<typeof deleteColumnRequest, 200>>(
      deleteColumnRequest(
        { param: { id, columnId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async updateProject(
    id: string,
    body: InferRequestType<typeof updateProjectRequest>["json"],
  ) {
    return read<InferResponseType<typeof updateProjectRequest, 200>>(
      updateProjectRequest(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async archiveProject(
    id: string,
    body: InferRequestType<typeof archiveProjectRequest>["json"],
  ) {
    return read<InferResponseType<typeof archiveProjectRequest, 200>>(
      archiveProjectRequest(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async transferProject(
    id: string,
    body: InferRequestType<typeof transferOwnershipRequest>["json"],
  ) {
    return read<InferResponseType<typeof transferOwnershipRequest, 200>>(
      transferOwnershipRequest(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async createInvitation(
    id: string,
    body: InferRequestType<typeof createInvitationRequest>["json"],
  ) {
    return read<InferResponseType<typeof createInvitationRequest, 201>>(
      createInvitationRequest(
        { param: { id }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async respondInvitation(
    id: string,
    invitationId: string,
    body: InferRequestType<typeof respondInvitationRequest>["json"],
  ) {
    return read<InferResponseType<typeof respondInvitationRequest, 200>>(
      respondInvitationRequest(
        { param: { id, invitationId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async revokeInvitation(id: string, invitationId: string) {
    return read<InferResponseType<typeof revokeInvitationRequest, 200>>(
      revokeInvitationRequest(
        { param: { id, invitationId }, json: {} },
        await mutationOptions(),
      ),
    );
  },
  async createJoinRequest(id: string) {
    return read<InferResponseType<typeof createJoinRequestRequest, 201>>(
      createJoinRequestRequest(
        { param: { id }, json: {} },
        await mutationOptions(),
      ),
    );
  },
  async resolveJoinRequest(
    id: string,
    requestId: string,
    body: InferRequestType<typeof resolveJoinRequestRequest>["json"],
  ) {
    return read<InferResponseType<typeof resolveJoinRequestRequest, 200>>(
      resolveJoinRequestRequest(
        { param: { id, requestId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async cancelJoinRequest(id: string, requestId: string) {
    return read<InferResponseType<typeof cancelJoinRequestRequest, 200>>(
      cancelJoinRequestRequest(
        { param: { id, requestId }, json: {} },
        await mutationOptions(),
      ),
    );
  },
  async changeMember(
    id: string,
    memberId: string,
    body: InferRequestType<typeof changeMemberRequest>["json"],
  ) {
    return read<InferResponseType<typeof changeMemberRequest, 200>>(
      changeMemberRequest(
        { param: { id, memberId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  async removeMember(
    id: string,
    memberId: string,
    body: InferRequestType<typeof removeMemberRequest>["json"],
  ) {
    return read<InferResponseType<typeof removeMemberRequest, 200>>(
      removeMemberRequest(
        { param: { id, memberId }, json: body },
        await mutationOptions(),
      ),
    );
  },
  getManagement(id: string) {
    return read<InferResponseType<typeof getManagementRequest, 200>>(
      getManagementRequest({ param: { id } }),
    );
  },
  listManagedProjects(query: ListQuery = {}) {
    return read<InferResponseType<typeof listManagedProjectsRequest, 200>>(
      listManagedProjectsRequest({
        query: {
          ...listQuery(query),
          ...(query.search ? { q: query.search } : {}),
        },
      }),
    );
  },
  listMyInvitations(page: Page = {}) {
    return read<InferResponseType<typeof listMyInvitationsRequest, 200>>(
      listMyInvitationsRequest({ query: pageQuery(page) }),
    );
  },
  listProjectInvitations(id: string, page: Page = {}) {
    return read<InferResponseType<typeof listProjectInvitationsRequest, 200>>(
      listProjectInvitationsRequest({ param: { id }, query: pageQuery(page) }),
    );
  },
  listJoinRequests(id: string, page: Page = {}) {
    return read<InferResponseType<typeof listJoinRequestsRequest, 200>>(
      listJoinRequestsRequest({ param: { id }, query: pageQuery(page) }),
    );
  },
  employeeOptions(
    id: string,
    query: Page & {
      purpose: "invitation" | "ownership";
      q?: string;
      search?: string;
    },
  ) {
    return read<InferResponseType<typeof employeeOptionsRequest, 200>>(
      employeeOptionsRequest({
        param: { id },
        query: {
          ...pageQuery(query),
          purpose: query.purpose,
          q: query.q ?? query.search,
        },
      }),
    );
  },
  listMemberPage(id: string, page: Page = {}) {
    return read<InferResponseType<typeof listMemberPageRequest, 200>>(
      listMemberPageRequest({ param: { id }, query: pageQuery(page) }),
    );
  },
  async logout(): Promise<void> {
    const generation = ++contextGeneration;
    const previousToken = csrfToken;
    csrfToken = undefined;
    try {
      const sessionResponse = await fetch("/api/v1/session", {
        credentials: "include",
        cache: "no-store",
      });
      if (sessionResponse.status === 401) {
        csrfToken = undefined;
        window.location.assign("/");
        return;
      }
      const session = await read<{ csrf_token?: string }>(
        Promise.resolve(sessionResponse),
      );
      if (!session.csrf_token)
        throw new ApiError(403, "Platform CSRF token is unavailable");
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": session.csrf_token },
      });
      if (!response.ok && response.status !== 401)
        await read<unknown>(Promise.resolve(response));
      csrfToken = undefined;
      window.location.assign("/");
    } catch (error) {
      if (generation === contextGeneration) csrfToken = previousToken;
      throw error;
    }
  },
};

export type Invitation = InferResponseType<
  typeof listProjectInvitationsRequest,
  200
>[number];
export type MyInvitation = InferResponseType<
  typeof listMyInvitationsRequest,
  200
>[number];
export type JoinRequest = InferResponseType<
  typeof listJoinRequestsRequest,
  200
>[number];
export type EmployeeOption = InferResponseType<
  typeof employeeOptionsRequest,
  200
>[number];
export type Management = InferResponseType<typeof getManagementRequest, 200>;
export type ColumnsMutation = InferResponseType<
  typeof createColumnRequest,
  201
>;
