import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
const mock = vi.hoisted(() => ({
  user: "alice",
  reconcile: vi.fn(),
  clear: vi.fn(),
  accept: vi.fn(),
  stop: vi.fn(),
  resync: vi.fn(),
}));
vi.mock("./session", () => ({
  useDoskaSession: () => ({ context: { user: { id: mock.user } } }),
}));
vi.mock("./live-reconcile", () => ({
  reconcileLiveAccess: mock.reconcile,
  clearLiveData: mock.clear,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@kaneo/libs", () => ({ resolveApiBaseUrl: () => "/api" }));
vi.mock("./live-cache", () => ({
  createLiveCacheScheduler: (
    _: unknown,
    options: { onResync: () => void },
  ) => ({
    accept: (event: { type: string }) => {
      mock.accept(event);
      if (event.type === "ready") options.onResync();
    },
    stop: mock.stop,
    resyncAvailableQueries: mock.resync,
  }),
}));
import { DoskaLiveUpdates } from "./live-updates";
class Stream {
  static all: Stream[] = [];
  listeners = new Map<string, (event: MessageEvent) => void>();
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor() {
    Stream.all.push(this);
  }
  addEventListener(name: string, fn: (event: MessageEvent) => void) {
    this.listeners.set(name, fn);
  }
  emit(name: string, body: unknown = { version: 1 }) {
    this.listeners.get(name)?.(
      new MessageEvent(name, { data: JSON.stringify(body) }),
    );
  }
}
function Editor() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="draft"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}
function setup() {
  const client = new QueryClient();
  const element = () => (
    <QueryClientProvider client={client}>
      <DoskaLiveUpdates>
        <Editor />
      </DoskaLiveUpdates>
    </QueryClientProvider>
  );
  const view = render(element());
  return { ...view, changeUser: () => view.rerender(element()) };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.user = "alice";
  mock.reconcile.mockResolvedValue("same-user");
  mock.clear.mockResolvedValue(undefined);
  Stream.all = [];
  vi.stubGlobal("EventSource", Stream);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("live lifecycle", () => {
  it("hides until ready verification, preserving a same-user dirty editor during reset", async () => {
    setup();
    expect(screen.getByLabelText("draft")).not.toBeVisible();
    await act(async () => {
      Stream.all[0].emit("ready");
    });
    const input = screen.getByLabelText("draft");
    expect(input).toBeVisible();
    fireEvent.change(input, { target: { value: "unsaved" } });
    let resolve!: (value: string) => void;
    mock.reconcile.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      Stream.all[0].emit("reset", { version: 1, reason: "resync" });
    });
    expect(input).not.toBeVisible();
    expect(input).toHaveValue("unsaved");
    await act(async () => {
      resolve("same-user");
    });
    expect(input).toBeVisible();
    expect(input).toHaveValue("unsaved");
  });
  it("ignores queued old-source callbacks and closes all timers on unmount", async () => {
    const view = setup();
    const old = Stream.all[0];
    await act(async () => {
      old.emit("ready");
      old.onerror?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const current = Stream.all[1];
    expect(current).toBeDefined();
    const count = mock.accept.mock.calls.length;
    await act(async () => {
      old.emit("ready");
      old.onerror?.();
    });
    expect(mock.accept).toHaveBeenCalledTimes(count);
    expect(current.close).not.toHaveBeenCalled();
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(Stream.all).toHaveLength(2);
    expect(current.close).toHaveBeenCalledOnce();
    expect(mock.stop).toHaveBeenCalledOnce();
  });
  it("retries a missing ready frame and recovers from a failed access check", async () => {
    setup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(Stream.all.length).toBeGreaterThan(1);
    mock.reconcile.mockRejectedValueOnce(new Error("network"));
    await act(async () => {
      Stream.all.at(-1)!.emit("ready");
    });
    expect(screen.getByLabelText("draft")).not.toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByLabelText("draft")).toBeVisible();
  });
  it("remounts drafts and clears private data when the user changes", async () => {
    const view = setup();
    await act(async () => {
      Stream.all[0].emit("ready");
    });
    fireEvent.change(screen.getByLabelText("draft"), {
      target: { value: "alice secret" },
    });
    mock.user = "bob";
    await act(async () => {
      view.changeUser();
    });
    expect(mock.clear).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("draft")).toHaveValue("");
    expect(screen.getByLabelText("draft")).not.toBeVisible();
    await act(async () => {
      Stream.all.at(-1)!.emit("ready");
    });
    expect(screen.getByLabelText("draft")).toBeVisible();
  });
});
