import { api, APIError } from "./api";

export type F12Image = {
  id: string;
  name: string;
  size: number;
  segments: string[];
  recipe: string;
  filesystem: string;
  compatibility: string;
  existing?: boolean;
};
export type F12Pending = {
  id: string;
  name: string;
  size: number;
  offset: number;
  state: string;
};
export type F12Library = {
  pending?: F12Pending;
  items: F12Image[];
  segments: Record<string, string>;
  boot_urls: Record<string, string>;
  pxe?: Record<string, "idle" | "waiting" | "active" | "error" | "manual">;
};
export type F12Menu = {
  segment: string;
  items: Pick<F12Image, "id" | "name" | "recipe">[];
};
type UploadPosition = { id: string; offset: number; status?: "processing" };
const chunkSize = 4 * 1024 * 1024;
export const maxImageSize = 32 * 1024 ** 3;

export function sizeLabel(bytes: number) {
  if (bytes < 1024) return bytes + " Б";
  const power = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = (bytes / 1024 ** power).toLocaleString("ru-RU", {
    maximumFractionDigits: 1,
  });
  return value + " " + ["Б", "КиБ", "МиБ", "ГиБ"][power];
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function send<T>(
  path: string,
  method: string,
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<T>(path, method, body, {}, signal);
    } catch (error) {
      const transient =
        error instanceof TypeError ||
        (error instanceof APIError &&
          [429, 502, 503, 504].includes(error.status));
      if (!transient || signal.aborted || attempt >= 3) throw error;
      await delay(500 * 2 ** attempt, signal);
    }
  }
}

// The server acknowledges each slice after writing it. Retrying a dropped reply reuses
// the same upload ID and offset, including when requesting the final inspection.
export async function uploadISO(
  base: string,
  id: string,
  file: File,
  segments: string[],
  signal: AbortSignal,
  progress: (bytes: number, processing: boolean) => void,
): Promise<F12Image> {
  const path = base + "/uploads/" + id;
  const started = await send<UploadPosition>(
    path,
    "PUT",
    { name: file.name, size: file.size, segments },
    signal,
  );
  let offset = started.offset;
  if (
    started.id !== id ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > file.size
  )
    throw new Error("Сервис вернул неверную позицию загрузки.");
  progress(offset, offset === file.size);
  while (offset < file.size) {
    const end = Math.min(offset + chunkSize, file.size);
    const reply = await send<UploadPosition>(
      path + "/chunks/" + offset,
      "PUT",
      file.slice(offset, end),
      signal,
    );
    if (reply.id !== id || reply.offset !== end)
      throw new Error("Сервис не подтвердил запись части ISO.");
    offset = end;
    progress(offset, offset === file.size);
  }
  return finishISO(base, id, signal);
}

export async function finishISO(
  base: string,
  id: string,
  signal: AbortSignal,
): Promise<F12Image> {
  const path = base + "/uploads/" + id;
  for (;;) {
    const reply = await send<F12Image | UploadPosition>(
      path + "/complete",
      "POST",
      {},
      signal,
    );
    if ("recipe" in reply) return reply;
    if (reply.id !== id || reply.status !== "processing")
      throw new Error("Сервис не вернул результат подготовки образа.");
    await delay(2000, signal);
  }
}
