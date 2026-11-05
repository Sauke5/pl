import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "./api";
import { DoskaTaskAttachments } from "./task-attachments";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
    i18n: { language: "ru" },
  }),
}));
vi.mock("./api", () => ({
  ApiError: class extends Error {},
  api: {
    listAttachments: vi.fn(),
    deleteAttachment: vi.fn(),
    attachmentDownloadUrl: vi.fn(),
    uploadAttachment: vi.fn(),
  },
}));
const attached = {
  id: "a",
  filename: "note.txt",
  size: 1024,
  createdAt: "2026-10-23T00:00:00Z",
  createdBy: "owner",
};
const dirty = vi.fn();
function mount(canWork = true) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <DoskaTaskAttachments
        projectId="p"
        taskId="t"
        canWork={canWork}
        onDirtyChange={dirty}
      />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.listAttachments).mockResolvedValue([attached]);
  vi.mocked(api.attachmentDownloadUrl).mockReturnValue("/doska/api/file");
});
afterEach(cleanup);
it("shows downloadable files but no write controls to an observer", async () => {
  mount(false);
  const link = await screen.findByRole("link", { name: "note.txt" });
  expect(link.getAttribute("download")).toBe("note.txt");
  expect(screen.queryByRole("button", { name: "attachmentAdd" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "attachmentDeleteNamed:note.txt" }),
  ).toBeNull();
});
it("deletes only after confirmation and refreshes the list", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", {
      name: "attachmentDeleteNamed:note.txt",
    }),
  );
  expect(api.deleteAttachment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "cancel" }));
  expect(api.deleteAttachment).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "attachmentDeleteNamed:note.txt" }),
  );
  vi.mocked(api.listAttachments).mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: "delete" }));
  await screen.findByText("attachmentsEmpty");
  expect(api.deleteAttachment).toHaveBeenCalledWith("p", "t", "a");
});
it("keeps the same upload request for retry and marks the drawer dirty until success", async () => {
  vi.mocked(api.uploadAttachment)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(attached);
  mount();
  const file = new File(["text"], "note.txt", { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("attachmentAdd"), {
    target: { files: [file] },
  });
  await screen.findByText("attachmentUploadError");
  expect(dirty).toHaveBeenLastCalledWith(true);
  const original = vi.mocked(api.uploadAttachment).mock.calls[0]![3];
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  expect(
    vi.mocked(api.uploadAttachment).mock.calls[1]![3].clientRequestId,
  ).toBe(original.clientRequestId);
});
it("aborts cancellation and rejects oversized files before network", async () => {
  let options: Parameters<typeof api.uploadAttachment>[3] | undefined;
  vi.mocked(api.uploadAttachment).mockImplementation((_p, _t, _file, value) => {
    options = value;
    return new Promise((_resolve, reject) =>
      value.signal.addEventListener("abort", () =>
        reject(new DOMException("Cancelled", "AbortError")),
      ),
    );
  });
  mount();
  const file = new File(["text"], "note.txt");
  fireEvent.change(screen.getByLabelText("attachmentAdd"), {
    target: { files: [file] },
  });
  await waitFor(() => expect(options).toBeDefined());
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "attachmentCancelUpload" }),
    ),
  );
  expect(options!.signal.aborted).toBe(true);
  await waitFor(() => expect(dirty).toHaveBeenLastCalledWith(false));
  const large = new File(["x"], "large.txt");
  Object.defineProperty(large, "size", { value: 25 * 1024 * 1024 + 1 });
  fireEvent.change(screen.getByLabelText("attachmentAdd"), {
    target: { files: [large] },
  });
  expect(await screen.findByText("attachmentSizeError")).toBeTruthy();
  expect(api.uploadAttachment).toHaveBeenCalledTimes(1);
});
