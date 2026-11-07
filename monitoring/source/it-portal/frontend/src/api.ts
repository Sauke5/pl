import { ru } from "./ru";
import { useQuery, QueryClient } from "@tanstack/react-query";
import type { Session } from "./types";
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15000,
      refetchInterval: 60000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});
let csrf = "";
export class APIError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;
  fieldErrors?: Record<string, string>;
  constructor(
    message: string,
    status: number,
    code = "",
    details: Record<string, unknown> = {},
    fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.fieldErrors = fieldErrors;
  }
}
export async function apiResponse(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(
    path.startsWith("/auth/") || path.startsWith("/doska/api/doska/")
      ? path
      : `/api/v1${path}`,
    {
      method,
      credentials: "same-origin",
      signal,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "GET" ? {} : { "X-CSRF-Token": csrf }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (!response.ok) {
    let message = ru.oshibka_zaprosa + response.status + ")";
    let code = "";
    let details: Record<string, unknown> = {};
    let fieldErrors: Record<string, string> | undefined;
    try {
      const parsed = await response.json();
      const payload =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : {};
      details = payload;
      message =
        payload.message ||
        (typeof payload.error === "string" ? payload.error : message);
      code =
        typeof payload.error === "string"
          ? payload.error
          : payload.error?.code || payload.code || "";
      if (
        payload.field_errors &&
        typeof payload.field_errors === "object" &&
        !Array.isArray(payload.field_errors)
      ) {
        const entries = Object.entries(payload.field_errors)
          .slice(0, 100)
          .filter(
            ([field, value]) =>
              /^[a-z][a-z0-9_.]{0,127}$/i.test(field) &&
              typeof value === "string" &&
              value.trim().length > 0 &&
              value.length <= 2000,
          );
        if (entries.length)
          fieldErrors = Object.fromEntries(entries) as Record<string, string>;
      }
    } catch {
      /* no body */
    }
    if (response.status === 401) {
      csrf = "";
      void queryClient.invalidateQueries({ queryKey: ["/session"] });
    }
    throw new APIError(message, response.status, code, details, fieldErrors);
  }
  return response;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await apiResponse(path, method, body, headers, signal);
  if (response.status === 204) return undefined as T;
  const result = (await response.json()) as T;
  if (path === "/session") csrf = (result as Session).csrf_token || "";
  return result;
}
export function useAPI<T>(path: string, enabled = true) {
  return useQuery({
    queryKey: [path],
    queryFn: () => api<T>(path),
    enabled,
    refetchInterval: path.startsWith("/jobs/") ? 2000 : 60000,
  });
}
export async function refresh() {
  await queryClient.invalidateQueries();
}
export function params(values: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value) p.set(key, value);
  });
  return p.toString();
}
export function errorText(error: unknown) {
  if (error instanceof APIError && error.code === "revision_conflict")
    return ru.zapis_uzhe_izmenena_obnovite_dannye_pered_povtornym_sohranenie;
  return error instanceof Error
    ? error.message
    : ru.ne_udalos_vypolnit_deystvie;
}
export function safeURL(value: string) {
  if (!value?.trim()) return undefined;
  try {
    const u = new URL(value, location.origin);
    return ["https:", "http:"].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}
let displayTimezone = "Europe/Moscow";
export function setTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("ru", { timeZone: value });
    displayTimezone = value;
  } catch {
    /* fallback */
  }
}
export function date(value?: string) {
  if (!value || value.startsWith("0001-")) return ru.eschyo_ne_bylo;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: displayTimezone,
  }).format(new Date(value));
}
