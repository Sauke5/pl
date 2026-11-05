import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  billing: true,
  smtp: true,
  send: vi.fn(),
  selectDistinctOn: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("@kaneo/email", () => ({
  isSmtpConfigured: () => mocks.smtp,
  sendTrialReminderEmail: mocks.send,
}));
vi.mock("../billing/config", () => ({
  isBillingEnabled: () => mocks.billing,
  trialDays: () => 14,
}));
vi.mock("../database", () => ({
  default: {
    selectDistinctOn: mocks.selectDistinctOn,
    select: mocks.select,
    insert: mocks.insert,
  },
}));
import { checkTrialReminders } from "./trial-reminders";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.billing = true;
  mocks.smtp = true;
  vi.stubEnv("KANEO_CLIENT_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("configured trial reminder links", () => {
  it.each([
    "not-a-url",
    "/installation",
    "ftp://tasks.example.invalid",
    "https://tasks.example.invalid/?page=other",
  ])(
    "does not claim or send reminders with an unusable base URL: %s",
    async (value) => {
      vi.stubEnv("KANEO_CLIENT_URL", value);
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await checkTrialReminders()).toEqual({ degraded: true });
      expect(mocks.selectDistinctOn).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, "", "   "])(
    "does not claim or send reminders without the installation URL: %s",
    async (value) => {
      vi.stubEnv("KANEO_CLIENT_URL", value);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await checkTrialReminders()).toEqual({ degraded: true });
      expect(mocks.selectDistinctOn).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        "Trial reminder links require KANEO_CLIENT_URL",
      );
    },
  );

  it("preserves the configured origin and path in an actual reminder", async () => {
    vi.stubEnv(
      "KANEO_CLIENT_URL",
      "https://tasks.example.invalid/installation/",
    );
    const query: Record<string, unknown> = {};
    for (const method of [
      "from",
      "innerJoin",
      "leftJoin",
      "where",
      "orderBy",
      "as",
    ])
      query[method] = vi.fn(() => query);
    query.limit = mocks.limit;
    mocks.selectDistinctOn.mockReturnValue(query);
    mocks.select.mockReturnValue(query);
    mocks.limit
      .mockResolvedValueOnce([
        {
          userId: "test-user",
          workspaceId: "test-workspace",
          workspaceName: "Test",
          email: "owner@example.invalid",
          trialEndsAt: new Date(Date.now() + 2 * 86400000),
        },
      ])
      .mockResolvedValueOnce([]);
    const claimed = {
      values: vi.fn(),
      onConflictDoNothing: vi.fn(),
      returning: vi.fn(async () => [{}]),
    };
    claimed.values.mockReturnValue(claimed);
    claimed.onConflictDoNothing.mockReturnValue(claimed);
    mocks.insert.mockReturnValue(claimed);
    expect(await checkTrialReminders()).toEqual({ degraded: false });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(
      "owner@example.invalid",
      expect.any(String),
      expect.objectContaining({
        billingUrl:
          "https://tasks.example.invalid/installation/dashboard/settings/workspace/billing",
      }),
    );
  });

  it("keeps disabled billing and SMTP idle without requiring a URL", async () => {
    mocks.billing = false;
    expect(await checkTrialReminders()).toEqual({ degraded: false });
    mocks.billing = true;
    mocks.smtp = false;
    expect(await checkTrialReminders()).toEqual({ degraded: false });
    expect(mocks.selectDistinctOn).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
