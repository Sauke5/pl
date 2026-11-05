package store

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"pl/portal/internal/model"
)

func TestXrayResourceOnlyRemovalPreservesUnscopedRules(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	i, j, err := s.QueueModule(ctx, "local-admin", "xray:projection", "", "install", model.ModuleRequest{ModuleID: "xray", Mode: "local", Name: "Office Xray"})
	if err != nil {
		t.Fatal(err)
	}
	if i.IntegrationID != "" || i.ResourceID == "" {
		t.Fatalf("wrong links %+v", i)
	}
	resource, err := Get[model.Resource](ctx, s, "resource", i.ResourceID)
	if err != nil || resource.URL != "/#modules?instance="+i.ID+"&view=xray" {
		t.Fatalf("resource %+v %v", resource, err)
	}
	i.ObservedState = "running"
	j.Status = "succeeded"
	j.Result = map[string]any{"instance": i}
	if err = s.Finish(ctx, j); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.QueueModule(ctx, "local-admin", "xray:duplicate", "", "install", model.ModuleRequest{ModuleID: "xray", Mode: "local", Name: "Other Xray"}); err == nil {
		t.Fatal("duplicate accepted")
	}
	draft := model.DefaultXrayConfiguration()
	draft.Revision = 1
	draft.Ref = uuid.NewString()
	if _, err = s.SaveXrayDraft(ctx, i.ID, "local-admin", draft); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SaveXrayDraft(ctx, i.ID, "local-admin", draft); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale revision %v", err)
	}
	// A module without an integration must not adopt empty source IDs as ownership.
	manual := model.Problem{ID: "manual-problem", IntegrationID: "", Title: "Manual incident"}
	if _, err = s.Save(ctx, "problem", manual.ID, 0, manual, "local-admin"); err != nil {
		t.Fatal(err)
	}
	links := model.ProblemLinkConfig{Overrides: map[string]model.ProblemLinkOverride{}, Rules: []model.ProblemLinkRule{{ID: "global-rule", IntegrationID: "", ResourceIDs: []string{"unrelated-resource"}}}}
	if _, err = s.Save(ctx, "problem_links", "global", 0, links, "local-admin"); err != nil {
		t.Fatal(err)
	}
	i, j, err = s.QueueModule(ctx, "local-admin", "xray:remove", i.ID, "remove", model.ModuleRequest{ConfirmName: i.Name})
	if err != nil {
		t.Fatal(err)
	}
	i.ObservedState = "absent"
	j.Status = "succeeded"
	j.Result = map[string]any{"instance": i}
	if err = s.Finish(ctx, j); err != nil {
		t.Fatal(err)
	}
	if _, err = Get[model.Resource](ctx, s, "resource", i.ResourceID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("resource survived %v", err)
	}
	if _, err = Get[model.Problem](ctx, s, "problem", manual.ID); err != nil {
		t.Fatal("removal touched unowned incident", err)
	}
	remaining, err := Get[model.ProblemLinkConfig](ctx, s, "problem_links", "global")
	if err != nil || len(remaining.Rules) != 1 || remaining.Rules[0].ID != "global-rule" {
		t.Fatalf("removal touched unscoped rule %+v %v", remaining, err)
	}
	if _, err = Get[model.ModuleInstance](ctx, s, "module_tombstone", i.ID); err != nil {
		t.Fatal(err)
	}
	instances, err := List[model.Integration](ctx, s, "integration")
	if err != nil || len(instances) != 0 {
		t.Fatalf("fake integration %+v %v", instances, err)
	}
	if _, j, err = s.QueueModule(ctx, "local-admin", "xray:remove-again", i.ID, "remove", model.ModuleRequest{ConfirmName: i.Name}); err != nil || j.Status != "succeeded" {
		t.Fatalf("idempotent removal %+v %v", j, err)
	}
}
