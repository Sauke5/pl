/** A dedicated bounded JSON lane; other writes retain their existing limit. */
export function taskImportRoute(method: string, pathname: string): boolean {
  return (
    method === "POST" &&
    /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/task-imports$/.test(pathname)
  );
}

/** Raw uploads use a separate streaming verifier, never the generic JSON body reader. */
export function attachmentUploadRoute(method: string, pathname: string) {
  if (method !== "PUT") return null;
  const match =
    /^\/api\/doska\/projects\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)\/attachment-uploads\/([A-Za-z0-9_-]+)\/content$/.exec(
      pathname,
    );
  return match
    ? { projectId: match[1]!, taskId: match[2]!, uploadId: match[3]! }
    : null;
}

/** Only handlers already adapted to project ACL belong in this allowlist. */
const readPaths = [
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/resource-link-capabilities$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/resource-links$/,
  /^\/api\/doska\/overview$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/labels$/,
  /^\/api\/doska\/events$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/fields$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/attachments(?:\/[A-Za-z0-9_-]+\/content)?$/,
  /^\/api\/doska\/preferences$/,
  /^\/api\/doska\/notifications(?:\/(?:unread-count|preferences))?$/,
  /^\/api\/doska\/templates(?:\/[A-Za-z0-9_-]+)?$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/template-selection$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/(comments|checklists)$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+$/,
  /^\/api\/doska\/my-tasks$/,
  /^\/api\/doska\/task-search$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/access$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/columns$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/relations$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks(?:\/[A-Za-z0-9_-]+(?:\/history)?)?$/,
  /^\/api\/doska\/(projects|managed-projects)$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/employee-options$/,
  /^\/api\/doska\/invitations$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/(invitations|join-requests|members)$/,
  /^\/api\/doska\/context$/,
  /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/management$/,
  /^\/api\/project\/?$/,
  /^\/api\/project\/[A-Za-z0-9_-]+$/,
  /^\/api\/task\/tasks\/[A-Za-z0-9_-]+$/,
];
const taskReserved = new Set([
  "assigned",
  "tasks",
  "export",
  "import",
  "description-matches",
  "by-ticket-id",
]);

export function isAdaptedDoskaRead(method: string, pathname: string): boolean {
  if (method !== "GET") return false;
  if (readPaths.some((pattern) => pattern.test(pathname))) return true;
  const task = /^\/api\/task\/([A-Za-z0-9_-]+)$/.exec(pathname);
  return Boolean(task?.[1] && !taskReserved.has(task[1]));
}

/** Mutation endpoints opt in individually; native workspace mutations stay closed. */
export function adaptedDoskaScope(
  method: string,
  pathname: string,
): "doska:read" | "doska:write" | null {
  if (taskImportRoute(method, pathname)) return "doska:write";
  if (
    (method === "POST" &&
      /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/fields(?:\/reorder)?$/.test(
        pathname,
      )) ||
    (method === "PATCH" &&
      /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/fields\/[A-Za-z0-9_-]+$/.test(
        pathname,
      ))
  )
    return "doska:write";
  if (
    (method === "POST" &&
      (pathname === "/api/doska/catalog/task-links" ||
        /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/(?:from-resource|[A-Za-z0-9_-]+\/resource-links)$/.test(
          pathname,
        ))) ||
    (method === "DELETE" &&
      /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/resource-links\/[A-Za-z0-9_-]+$/.test(
        pathname,
      ))
  )
    return "doska:write";
  if (attachmentUploadRoute(method, pathname)) return "doska:write";
  if (
    (method === "POST" &&
      /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/attachment-uploads(?:\/[A-Za-z0-9_-]+\/finalize)?$/.test(
        pathname,
      )) ||
    (method === "DELETE" &&
      /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/(?:attachment-uploads|attachments)\/[A-Za-z0-9_-]+$/.test(
        pathname,
      ))
  )
    return "doska:write";
  if (isAdaptedDoskaRead(method, pathname)) return "doska:read";
  if (method === "PATCH" && pathname === "/api/doska/preferences")
    return "doska:write";
  if (
    (method === "PATCH" &&
      pathname === "/api/doska/notifications/preferences") ||
    (method === "POST" && pathname === "/api/doska/notifications/read-all") ||
    (method === "PATCH" &&
      /^\/api\/doska\/notifications\/[A-Za-z0-9_-]+\/read$/.test(pathname))
  )
    return "doska:write";
  if (
    method === "POST" &&
    (pathname === "/api/doska/templates" ||
      /^\/api\/doska\/templates\/[A-Za-z0-9_-]+\/projects$/.test(pathname) ||
      /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/template-preview$/.test(
        pathname,
      ))
  )
    return "doska:write";
  if (
    method === "PATCH" &&
    /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/template-selection\/[A-Za-z0-9_-]+$/.test(
      pathname,
    )
  )
    return "doska:write";

  const detailPath =
    /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/(.+)$/.exec(
      pathname,
    )?.[1];
  if (
    detailPath &&
    ((method === "POST" &&
      /^(comments|checklists|checklists\/[A-Za-z0-9_-]+\/items)$/.test(
        detailPath,
      )) ||
      ((method === "PATCH" || method === "DELETE") &&
        /^(comments\/[A-Za-z0-9_-]+|checklists\/[A-Za-z0-9_-]+(?:\/items\/[A-Za-z0-9_-]+)?)$/.test(
          detailPath,
        )) ||
      (method === "PUT" &&
        /^checklists\/(?:[A-Za-z0-9_-]+\/items\/)?order$/.test(detailPath)))
  )
    return "doska:write";
  if (method === "POST" && pathname === "/api/doska/projects")
    return "doska:write";
  if (
    method === "PATCH" &&
    /^\/api\/doska\/projects\/[A-Za-z0-9_-]+$/.test(pathname)
  )
    return "doska:write";
  if (
    method === "POST" &&
    /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/(archive|owner)$/.test(pathname)
  )
    return "doska:write";
  if (
    method === "POST" &&
    (/^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/(invitations|join-requests)$/.test(
      pathname,
    ) ||
      /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/invitations\/[A-Za-z0-9_-]+\/(respond|revoke)$/.test(
        pathname,
      ) ||
      /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/join-requests\/[A-Za-z0-9_-]+\/(resolve|cancel)$/.test(
        pathname,
      ))
  )
    return "doska:write";
  if (
    (method === "PATCH" || method === "DELETE") &&
    /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/members\/[A-Za-z0-9_-]+$/.test(
      pathname,
    )
  )
    return "doska:write";
  if (
    method === "POST" &&
    (/^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks$/.test(pathname) ||
      /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/archive$/.test(
        pathname,
      ))
  )
    return "doska:write";
  if (
    (method === "PATCH" || method === "DELETE") &&
    /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+$/.test(
      pathname,
    )
  )
    return "doska:write";
  if (
    method === "POST" &&
    (/^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/columns(?:\/reorder)?$/.test(
      pathname,
    ) ||
      /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/relations$/.test(
        pathname,
      ))
  )
    return "doska:write";
  if (
    (method === "PATCH" || method === "DELETE") &&
    /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/columns\/[A-Za-z0-9_-]+$/.test(
      pathname,
    )
  )
    return "doska:write";
  if (
    method === "DELETE" &&
    /^\/api\/doska\/projects\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/relations\/[A-Za-z0-9_-]+$/.test(
      pathname,
    )
  )
    return "doska:write";
  return null;
}
