export type DirectoryTelemetry = {
  ready: boolean;
  leaseExpiresTimestampSeconds: number;
  lastSuccessTimestampSeconds: number;
};
const jobNames = ["doska-reminders", "doska-attachments-cleanup"] as const;
type JobName = (typeof jobNames)[number];
type JobTelemetry = {
  enabled: boolean;
  lastSuccess: number;
  lastRunSuccess: boolean;
  runs: number;
  errors: number;
};
const emptyJob = (): JobTelemetry => ({
  enabled: false,
  lastSuccess: 0,
  lastRunSuccess: false,
  runs: 0,
  errors: 0,
});
const finiteTimestamp = (value: number) =>
  Number.isFinite(value) && value >= 0 ? value : 0;

/** Fixed-cardinality, process-local observations from existing worker runs. */
export class DoskaTelemetry {
  private readonly jobs: Record<JobName, JobTelemetry> = {
    "doska-reminders": emptyJob(),
    "doska-attachments-cleanup": emptyJob(),
  };
  constructor(
    private readonly clock: () => number = Date.now,
    private readonly processStartedAt = Date.now() / 1000 - process.uptime(),
  ) {}
  configureJobs(enabled: { reminders: boolean; attachmentsCleanup: boolean }) {
    this.jobs["doska-reminders"].enabled = enabled.reminders;
    this.jobs["doska-attachments-cleanup"].enabled = enabled.attachmentsCleanup;
  }
  recordJob(name: string, success: boolean) {
    if (!jobNames.includes(name as JobName)) return;
    const job = this.jobs[name as JobName];
    job.runs++;
    job.lastRunSuccess = success;
    if (success) job.lastSuccess = finiteTimestamp(this.clock() / 1000);
    else job.errors++;
  }
  render(directory?: DirectoryTelemetry): string {
    const lines: string[] = [];
    const scalar = (name: string, help: string, value: number) => {
      lines.push(
        `# HELP ${name} ${help}`,
        `# TYPE ${name} gauge`,
        `${name} ${value}`,
      );
    };
    scalar(
      "process_start_time_seconds",
      "Node process start time in Unix seconds.",
      finiteTimestamp(this.processStartedAt),
    );
    scalar(
      "doska_directory_ready",
      "Whether this process has a current directory lease.",
      directory?.ready ? 1 : 0,
    );
    scalar(
      "doska_directory_lease_expires_timestamp_seconds",
      "Directory lease expiry in Unix seconds; zero before synchronization or after stop.",
      finiteTimestamp(directory?.leaseExpiresTimestampSeconds ?? 0),
    );
    scalar(
      "doska_directory_last_success_timestamp_seconds",
      "Last committed directory synchronization in Unix seconds; zero before success.",
      finiteTimestamp(directory?.lastSuccessTimestampSeconds ?? 0),
    );
    const metrics = [
      [
        "enabled",
        "gauge",
        "Whether the job is scheduled.",
        (job: JobTelemetry) => Number(job.enabled),
      ],
      [
        "last_success_timestamp_seconds",
        "gauge",
        "Last successful job completion in Unix seconds; zero before success.",
        (job: JobTelemetry) => job.lastSuccess,
      ],
      [
        "last_run_success",
        "gauge",
        "Whether the last job run succeeded; zero before the first run.",
        (job: JobTelemetry) => Number(job.lastRunSuccess),
      ],
      [
        "runs_total",
        "counter",
        "Completed job runs, including failures.",
        (job: JobTelemetry) => job.runs,
      ],
      [
        "errors_total",
        "counter",
        "Failed or degraded job runs.",
        (job: JobTelemetry) => job.errors,
      ],
    ] as const;
    for (const [suffix, type, help, value] of metrics) {
      const name = `doska_job_${suffix}`;
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const job of jobNames)
        lines.push(`${name}{worker="${job}"} ${value(this.jobs[job])}`);
    }
    return lines.join("\n") + "\n";
  }
}
export const doskaTelemetry = new DoskaTelemetry();
export const renderDoskaMetrics = (directory?: DirectoryTelemetry) =>
  doskaTelemetry.render(directory);
