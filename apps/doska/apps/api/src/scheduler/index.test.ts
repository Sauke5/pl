import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  jobs: [] as {
    pattern: string;
    options: unknown;
    run: () => Promise<void>;
    stop: ReturnType<typeof vi.fn>;
  }[],
  integrated: true,
  doska: vi.fn(async () => ({ degraded: false })),
  native: vi.fn(async () => ({ degraded: false })),
  webhook: vi.fn(async () => ({ degraded: false })),
  checkIn: vi.fn(() => "check-in"),
  recordJob: vi.fn(),
  configureJobs: vi.fn(),
}));
vi.mock("../doska/telemetry", () => ({
  doskaTelemetry: {
    recordJob: mocks.recordJob,
    configureJobs: mocks.configureJobs,
  },
}));
vi.mock("../doska/attachments/cleanup", () => ({
  runAttachmentCleanup: vi.fn(async () => ({ degraded: false })),
}));
vi.mock("croner", () => ({
  Cron: class {
    stop = vi.fn();
    constructor(
      pattern: string,
      options: unknown,
      callback?: () => Promise<void>,
    ) {
      mocks.jobs.push({
        pattern,
        options,
        run: (callback ?? options) as () => Promise<void>,
        stop: this.stop,
      });
    }
  },
}));
vi.mock("@sentry/node", () => ({
  captureCheckIn: mocks.checkIn,
  captureException: vi.fn(),
}));
vi.mock("../doska/mode", () => ({ isDoskaIntegrated: () => mocks.integrated }));
vi.mock("../doska/reminders/service", () => ({
  runDoskaReminders: mocks.doska,
}));
vi.mock("./due-date-reminders", () => ({
  checkDueDateReminders: mocks.native,
}));
vi.mock("./project-webhook-reminders", () => ({
  checkProjectWebhookReminders: mocks.webhook,
}));
vi.mock("../storage/cleanup-queue", () => ({
  retryStorageCleanup: vi.fn(async () => ({})),
}));
vi.mock("./draft-upload-cleanup", () => ({
  cleanupDraftUploads: vi.fn(async () => ({})),
}));
vi.mock("../plugins/github/services/deferred-issue-edits", () => ({
  replayDeferredIssueEdits: vi.fn(async () => ({})),
}));
vi.mock("./seat-reconciliation", () => ({
  reconcileWorkspaceSeats: vi.fn(async () => ({})),
}));
vi.mock("./trial-reminders", () => ({
  checkTrialReminders: vi.fn(async () => ({})),
}));
import { initializeScheduler, shutdownScheduler } from "./index";
beforeEach(() => {
  shutdownScheduler();
  mocks.jobs.length = 0;
  vi.clearAllMocks();
  vi.stubEnv("DOSKA_ATTACHMENTS_DIRECTORY", "");
  mocks.integrated = true;
  mocks.doska.mockResolvedValue({ degraded: false });
});
afterEach(() => {
  shutdownScheduler();
  vi.unstubAllEnvs();
});
describe("reminder scheduler routing", () => {
  it("runs protected Doska reminders in integrated mode without native reminders", async () => {
    initializeScheduler();
    for (const job of mocks.jobs) await job.run();
    expect(mocks.doska).toHaveBeenCalledTimes(1);
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.webhook).not.toHaveBeenCalled();
    expect(
      mocks.jobs.filter(
        (job) =>
          job.pattern === "* * * * *" &&
          (job.options as { protect?: boolean })?.protect,
      ),
    ).toHaveLength(1);
    expect(mocks.checkIn).toHaveBeenCalledWith(
      expect.objectContaining({ monitorSlug: "doska-reminders", status: "ok" }),
    );
  });
  it("keeps native reminders in standalone mode", async () => {
    mocks.integrated = false;
    initializeScheduler();
    for (const job of mocks.jobs) await job.run();
    expect(mocks.doska).not.toHaveBeenCalled();
    expect(mocks.native).toHaveBeenCalledTimes(1);
    expect(mocks.webhook).toHaveBeenCalledTimes(1);
  });
  it("reports partial failures and stops every registered job once", async () => {
    mocks.doska.mockResolvedValue({ degraded: true });
    initializeScheduler();
    for (const job of mocks.jobs) await job.run();
    expect(mocks.checkIn).toHaveBeenCalledWith(
      expect.objectContaining({
        monitorSlug: "doska-reminders",
        status: "error",
      }),
    );
    shutdownScheduler();
    shutdownScheduler();
    for (const job of mocks.jobs) expect(job.stop).toHaveBeenCalledTimes(1);
  });
});

describe("scheduler telemetry observations", () => {
  it("marks absent attachment configuration disabled and reports successful runs", async () => {
    initializeScheduler();
    for (const job of mocks.jobs) await job.run();
    expect(mocks.configureJobs).toHaveBeenCalledWith({
      reminders: true,
      attachmentsCleanup: false,
    });
    expect(mocks.recordJob).toHaveBeenCalledWith("doska-reminders", true);
    shutdownScheduler();
    expect(mocks.configureJobs).toHaveBeenLastCalledWith({
      reminders: false,
      attachmentsCleanup: false,
    });
  });
  it("records degraded and thrown runs as failures", async () => {
    mocks.doska
      .mockResolvedValueOnce({ degraded: true })
      .mockRejectedValueOnce(new Error("failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    initializeScheduler();
    for (const job of mocks.jobs) await job.run();
    for (const job of mocks.jobs) await job.run();
    expect(
      mocks.recordJob.mock.calls.filter(([name]) => name === "doska-reminders"),
    ).toEqual([
      ["doska-reminders", false],
      ["doska-reminders", false],
    ]);
    vi.restoreAllMocks();
  });
  it("marks configured attachment cleanup enabled", async () => {
    vi.stubEnv("DOSKA_ATTACHMENTS_DIRECTORY", "/synthetic");
    initializeScheduler();
    for (const job of mocks.jobs) await job.run();
    expect(mocks.configureJobs).toHaveBeenCalledWith({
      reminders: true,
      attachmentsCleanup: true,
    });
    expect(mocks.recordJob).toHaveBeenCalledWith(
      "doska-attachments-cleanup",
      true,
    );
  });
});
