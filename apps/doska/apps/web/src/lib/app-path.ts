/** Browser paths outside TanStack Router must use the same deployment prefix. */
export function appPath(path = "", base = import.meta.env.BASE_URL): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
