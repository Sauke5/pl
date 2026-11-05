/**
 * Resolves the Hono client base URL from `VITE_API_URL` (or default).
 * If the value already ends with `/api`, it is returned as-is; otherwise `/api` is appended.
 */
export function resolveApiBaseUrl(
  viteApiUrl: string | undefined,
  basePath = "/",
  doskaMode?: string,
): string {
  if (doskaMode === "platform") {
    return `${basePath.replace(/\/+$/, "")}/api`;
  }
  const raw =
    viteApiUrl || (basePath !== "/" ? basePath : "http://localhost:1337");
  const baseUrl = raw.replace(/\/+$/, "");
  return baseUrl.endsWith("/api") ? baseUrl : `${baseUrl}/api`;
}
