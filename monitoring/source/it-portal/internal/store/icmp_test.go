package store

import (
	"context"
	"pl/portal/internal/model"
	"strings"
	"testing"
)

func TestICMPOutputIsPreservedInDetailAndOmittedFromTimelines(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	job, err := s.Enqueue(ctx, model.Job{Kind: "check", Actor: "admin", IdempotencyKey: "icmp-full-output", Parameters: map[string]any{"kind": "icmp", "target": "10.1.2.3"}})
	if err != nil {
		t.Fatal(err)
	}
	raw := strings.Repeat("icmp reply\n", 2000)
	job.Status = "succeeded"
	job.Result = map[string]any{"raw_output": raw, "received": 2000}
	if err = s.Finish(ctx, job); err != nil {
		t.Fatal(err)
	}
	jobs, err := s.Jobs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].Result["raw_output"] != nil || jobs[0].Result["received"] != float64(2000) {
		t.Fatal("timeline should keep stats only")
	}
	detail, err := s.Job(ctx, job.ID)
	if err != nil || detail.Result["raw_output"] != nil {
		t.Fatal("ordinary detail must omit raw output", err)
	}
	full, err := s.JobOutput(ctx, job.ID)
	if err != nil || full != raw {
		t.Fatal("full output lost", err)
	}
}
