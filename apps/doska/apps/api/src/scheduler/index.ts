import { doskaTelemetry } from "../doska/telemetry";
import { runAttachmentCleanup } from "../doska/attachments/cleanup";
import { retryStorageCleanup } from "../storage/cleanup-queue";
import { cleanupDraftUploads } from "./draft-upload-cleanup";
import { replayDeferredIssueEdits } from "../plugins/github/services/deferred-issue-edits";
import * as Sentry from "@sentry/node";
import { Cron } from "croner";
import { checkDueDateReminders } from "./due-date-reminders";
import { checkProjectWebhookReminders } from "./project-webhook-reminders";
import { reconcileWorkspaceSeats } from "./seat-reconciliation";
import { checkTrialReminders } from "./trial-reminders";
import { isDoskaIntegrated } from "../doska/mode";
import { runDoskaReminders } from "../doska/reminders/service";

const jobs: Cron[] = [];

type JobOutcome = { degraded?: boolean };

// Cron jobs swallow their operational failures (per-item try/catch) so they
// can keep processing the rest of the batch. Reporting Sentry status purely
// from the thrown-rejection channel would always show "ok" for any partially
// failed run. Inspect the returned outcome instead so handled failures light
// up the monitor without aborting the rest of the work. Unexpected throws are
// captured as exception events and swallowed so one bad tick can't take down
// the scheduler via an unhandled rejection.
function withCheckIn<T>(name: string, fn: () => Promise<T>) {
  return async (): Promise<void> => {
    const checkInId = Sentry.captureCheckIn({
      monitorSlug: name,
      status: "in_progress",
    });
    let success = false;
    try {
      const result = await fn();
      const degraded = Boolean(
        (result as JobOutcome | null | undefined)?.degraded,
      );
      success = !degraded;
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug: name,
        status: degraded ? "error" : "ok",
      });
    } catch (error) {
      Sentry.captureException(error, { tags: { area: "cron", job: name } });
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug: name,
        status: "error",
      });
      console.error(`Cron job ${name} failed`, error);
    } finally {
      doskaTelemetry.recordJob(name, success);
    }
  };
}

export function initializeScheduler(): void {
  doskaTelemetry.configureJobs({
    reminders: isDoskaIntegrated(),
    attachmentsCleanup:
      isDoskaIntegrated() && Boolean(process.env.DOSKA_ATTACHMENTS_DIRECTORY),
  });
  jobs.push(
    new Cron(
      "* * * * *",
      withCheckIn("deferred-issue-edits", replayDeferredIssueEdits),
    ),
  );
  jobs.push(
    new Cron(
      "*/5 * * * *",
      { protect: true },
      withCheckIn("storage-cleanup", retryStorageCleanup),
    ),
  );
  jobs.push(
    new Cron(
      "31 * * * *",
      { protect: true },
      withCheckIn("draft-upload-cleanup", cleanupDraftUploads),
    ),
  );
  if (isDoskaIntegrated()) {
    if (process.env.DOSKA_ATTACHMENTS_DIRECTORY)
      jobs.push(
        new Cron(
          "* * * * *",
          { protect: true },
          withCheckIn("doska-attachments-cleanup", runAttachmentCleanup),
        ),
      );
    jobs.push(
      new Cron(
        "* * * * *",
        { protect: true },
        withCheckIn("doska-reminders", () => runDoskaReminders()),
      ),
    );
  } else {
    jobs.push(
      new Cron(
        "*/5 * * * *",
        withCheckIn("due-date-reminders", checkDueDateReminders),
      ),
    );
    jobs.push(
      new Cron(
        "*/5 * * * *",
        withCheckIn("project-webhook-reminders", checkProjectWebhookReminders),
      ),
    );
  }
  jobs.push(
    new Cron(
      "17 * * * *",
      withCheckIn("seat-reconciliation", reconcileWorkspaceSeats),
    ),
  );
  jobs.push(
    new Cron("23 * * * *", withCheckIn("trial-reminders", checkTrialReminders)),
  );
  console.log(
    isDoskaIntegrated()
      ? "Scheduler started (Doska reminders every minute)"
      : "Scheduler started (native reminders every 5 minutes)",
  );
}

export function shutdownScheduler(): void {
  doskaTelemetry.configureJobs({ reminders: false, attachmentsCleanup: false });
  for (const job of jobs) {
    job.stop();
  }
  jobs.length = 0;
}
