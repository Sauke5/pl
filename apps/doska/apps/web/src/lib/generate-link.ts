import { appPath } from "./app-path";

export function generateLink(path = "") {
  const baseUrl = import.meta.env.VITE_APP_URL;
  return baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
    : `${window.location.origin}${appPath(path)}`;
}
