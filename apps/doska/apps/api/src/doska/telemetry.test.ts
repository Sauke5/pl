import { describe, expect, it } from "vite-plus/test";
import { DoskaTelemetry } from "./telemetry";
describe("bounded process telemetry", () => {
  it("starts cold and resets on a new process instance", () => {
    const first = new DoskaTelemetry(() => 100000, 90);
    first.recordJob("doska-reminders", true);
    expect(first.render()).toContain(
      'doska_job_runs_total{worker="doska-reminders"} 1',
    );
    const restarted = new DoskaTelemetry(() => 110000, 110).render();
    expect(restarted).toContain("process_start_time_seconds 110\n");
    expect(restarted).toContain("doska_directory_ready 0\n");
    expect(restarted).toContain(
      'doska_job_last_success_timestamp_seconds{worker="doska-reminders"} 0',
    );
    expect(restarted).toContain(
      'doska_job_runs_total{worker="doska-reminders"} 0',
    );
  });
  it("counts failures while retaining last success and exposes enabled state", () => {
    const telemetry = new DoskaTelemetry(() => 100000, 90);
    telemetry.configureJobs({ reminders: true, attachmentsCleanup: false });
    telemetry.recordJob("doska-reminders", true);
    telemetry.recordJob("doska-reminders", false);
    const result = telemetry.render({
      ready: false,
      leaseExpiresTimestampSeconds: 80,
      lastSuccessTimestampSeconds: 50,
    });
    expect(result).toContain('doska_job_enabled{worker="doska-reminders"} 1');
    expect(result).toContain(
      'doska_job_enabled{worker="doska-attachments-cleanup"} 0',
    );
    expect(result).toContain(
      'doska_job_last_success_timestamp_seconds{worker="doska-reminders"} 100',
    );
    expect(result).toContain(
      'doska_job_last_run_success{worker="doska-reminders"} 0',
    );
    expect(result).toContain(
      'doska_job_runs_total{worker="doska-reminders"} 2',
    );
    expect(result).toContain(
      'doska_job_errors_total{worker="doska-reminders"} 1',
    );
    expect(result).toContain(
      "doska_directory_lease_expires_timestamp_seconds 80\n",
    );
  });
  it("never collects arbitrary job labels or invalid timestamps", () => {
    const telemetry = new DoskaTelemetry(() => Number.NaN, Number.NaN);
    const before = telemetry.render();
    for (const name of [
      "user-secret",
      'doska-reminders"}\nattack 1',
      "toString",
      "constructor",
    ])
      telemetry.recordJob(name, false);
    expect(telemetry.render()).toBe(before);
    expect(before).not.toContain("NaN");
    expect(before).not.toContain("Infinity");
    expect(
      new Set(
        [...before.matchAll(/worker="([^"]+)"/g)].map((match) => match[1]),
      ),
    ).toEqual(new Set(["doska-reminders", "doska-attachments-cleanup"]));
  });
});
