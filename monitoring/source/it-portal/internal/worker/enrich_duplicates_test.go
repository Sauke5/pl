package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"pl/portal/internal/model"
)

func TestEnrichExcludesEditedResourceButKeepsOtherDuplicates(t *testing.T) {
	w, s := testWorker(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<title>Internal Wiki</title>"))
	})
	ctx := context.Background()
	const target = "http://internal-wiki/"
	for _, id := range []string{"edited", "other"} {
		resource := model.Resource{ID: id, Name: id, URL: target, Lifecycle: "active"}
		if _, err := s.Save(ctx, "resource", id, 0, resource, "test"); err != nil {
			t.Fatal(err)
		}
	}
	for _, editedID := range []string{"edited", ""} {
		job, err := s.Enqueue(ctx, model.Job{Kind: "enrich", ResourceID: editedID, Actor: "test", IdempotencyKey: "enrich-" + editedID, Parameters: map[string]any{"target": target}})
		if err != nil {
			t.Fatal(err)
		}
		w.execute(ctx, job)
		got, err := s.Job(ctx, job.ID)
		if err != nil || got.Status != "succeeded" {
			t.Fatalf("enrich: status=%s error=%v", got.Status, err)
		}
		body, _ := json.Marshal(got.Result["possible_duplicates"])
		var duplicates []map[string]string
		if err := json.Unmarshal(body, &duplicates); err != nil {
			t.Fatal(err)
		}
		want := 2
		if editedID != "" {
			want = 1
		}
		if len(duplicates) != want {
			t.Fatalf("resource=%q duplicates=%s", editedID, body)
		}
		for _, duplicate := range duplicates {
			if editedID != "" && duplicate["id"] == editedID {
				t.Fatal("edited resource listed as its own duplicate")
			}
		}
	}
}
