package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"pl/portal/internal/model"
)

func TestPostgresHelpStateAtomicPrivateAndQuiet(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	state, e := s.HelpState(ctx, "ad:user-a")
	if e != nil || state.Disabled || state.Seen == nil || len(state.Seen) != 0 {
		t.Fatal(state, e)
	}
	var count int
	if e = s.Pool.QueryRow(ctx, "SELECT count(*) FROM documents WHERE kind='help_state'").Scan(&count); e != nil || count != 0 {
		t.Fatal("default GET persisted data", count, e)
	}
	topics := []string{"home", "catalog", "collections", "problems", "reports", "events", "settings", "resource-details"}
	var wg sync.WaitGroup
	for _, topic := range topics {
		wg.Add(1)
		go func(topic string) {
			defer wg.Done()
			if _, err := s.UpdateHelpState(ctx, "ad:user-a", &topic, nil); err != nil {
				t.Error(err)
			}
		}(topic)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		disabled := true
		if _, err := s.UpdateHelpState(ctx, "ad:user-a", nil, &disabled); err != nil {
			t.Error(err)
		}
	}()
	wg.Wait()
	// Read through another store instance, proving this is persisted per user.
	other := &Store{Pool: s.Pool, Q: s.Q}
	state, e = other.HelpState(ctx, "ad:user-a")
	if e != nil || !state.Disabled || len(state.Seen) != len(topics) {
		t.Fatal(state, e)
	}
	for _, topic := range topics {
		if !Contains(state.Seen, topic) {
			t.Fatal("lost concurrent topic", topic)
		}
	}
	for n := 0; n < 2; n++ {
		if _, e = s.UpdateHelpState(ctx, "ad:user-a", &topics[0], nil); e != nil {
			t.Fatal(e)
		}
	}
	state, e = other.HelpState(ctx, "ad:user-a")
	if e != nil || len(state.Seen) != len(topics) {
		t.Fatal("duplicate seen", state, e)
	}
	blank, e := s.HelpState(ctx, "ad:user-b")
	if e != nil || blank.Disabled || len(blank.Seen) != 0 {
		t.Fatal("cross-user leak", blank, e)
	}
	disabled := false
	state, e = s.UpdateHelpState(ctx, "ad:user-a", nil, &disabled)
	if e != nil || state.Disabled || len(state.Seen) != len(topics) {
		t.Fatal("explicit false lost seen", state, e)
	}
	if e = s.Pool.QueryRow(ctx, "SELECT (SELECT count(*) FROM events)+(SELECT count(*) FROM audit_events)").Scan(&count); e != nil || count != 0 {
		t.Fatal("help generated infrastructure audit noise", count, e)
	}
	if e = s.Pool.QueryRow(ctx, "SELECT count(*) FROM documents WHERE kind='preferences'").Scan(&count); e != nil || count != 0 {
		t.Fatal("help touched preferences", count, e)
	}
}

func TestPostgresHelpStateRejectsInvalidAndBoundsSeen(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, topic := range []string{"", " ", "home ", "HOME", "not-a-known-topic", "a/b", strings.Repeat("a", 81)} {
		if _, e := s.UpdateHelpState(ctx, "ad:user", &topic, nil); !errors.Is(e, ErrInvalid) {
			t.Fatal(topic, e)
		}
	}
	if _, e := s.UpdateHelpState(ctx, "ad:user", nil, nil); !errors.Is(e, ErrInvalid) {
		t.Fatal("empty patch", e)
	}
	topic := "home"
	if _, e := s.UpdateHelpState(ctx, " ", &topic, nil); !errors.Is(e, ErrInvalid) {
		t.Fatal("blank user", e)
	}
	full := model.HelpState{Seen: make([]string, 100)}
	for n := range full.Seen {
		full.Seen[n] = fmt.Sprintf("legacy-topic-%d", n)
	}
	if _, e := s.Pool.Exec(ctx, "INSERT INTO documents(kind,id,body) VALUES('help_state','ad:full',$1)", encode(full)); e != nil {
		t.Fatal(e)
	}
	disabled := true
	if _, e := s.UpdateHelpState(ctx, "ad:full", &topic, &disabled); !errors.Is(e, ErrInvalid) {
		t.Fatal("accepted >100 topics", e)
	}
	got, e := s.HelpState(ctx, "ad:full")
	if e != nil || got.Disabled || len(got.Seen) != 100 {
		t.Fatal("failed update not atomic", got, e)
	}
}
