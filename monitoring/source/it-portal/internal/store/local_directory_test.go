package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestLocalDirectoryFreshRightsFrozenSnapshotsAndIndependentNamespaces(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	actor := model.User{ID: "local-admin", Name: "Administrator", Admin: true}
	first, err := s.CreateLocalUser(ctx, actor, "first", "First local user", "fixture-private-password-material", false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateLocalUser(ctx, actor, "second", "Second local user", "fixture-private-password-material", true)
	if err != nil {
		t.Fatal(err)
	}
	cfg := LocalDirectoryConfig{UsersEnabled: true, BuiltinEnabled: true}
	now := time.Now().UTC()
	identity, err := s.LocalDirectoryIdentity(ctx, cfg, first.ID, now)
	if err != nil || identity.Subject != first.ID || identity.State != "active" || identity.PrimaryDepartmentID == nil || len(identity.HeadDepartmentIDs) != 0 || !identity.ValidUntil.After(identity.ObservedAt) {
		t.Fatal("local identity not backed by current account", identity, err)
	}
	other, err := s.LocalDirectoryIdentity(ctx, cfg, second.ID, now)
	if err != nil || other.PrimaryDepartmentID == nil || *other.PrimaryDepartmentID == *identity.PrimaryDepartmentID || len(other.HeadDepartmentIDs) != 0 {
		t.Fatal("local spaces or project rights merged", other, err)
	}
	var adCount int
	if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM org_employees").Scan(&adCount); err != nil || adCount != 0 {
		t.Fatal("local account was projected into AD organization", err)
	}
	page, err := s.LocalDirectorySnapshot(ctx, cfg, "employees", "", 1, now)
	if err != nil || len(page.Items) != 1 || page.NextCursor == "" || page.ChangesCursor == "" {
		t.Fatal("local snapshot not paginated", page, err)
	}
	frozenCursor, watermark := page.NextCursor, page.ChangesCursor
	first, err = s.UpdateLocalUser(ctx, actor, first.ID, "Renamed disabled user", true, true, first.Revision)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := s.LocalDirectoryIdentity(ctx, cfg, first.ID, now.Add(time.Second))
	if err != nil || fresh.State != "disabled" || fresh.Name != "Renamed disabled user" || fresh.Revision <= identity.Revision || len(fresh.HeadDepartmentIDs) != 0 {
		t.Fatal("disabled or role-changed account retained old identity", fresh, err)
	}
	frozen := []LocalDirectoryIdentity{}
	for _, raw := range page.Items {
		var item LocalDirectoryIdentity
		if json.Unmarshal(raw, &item) != nil {
			t.Fatal("invalid identity DTO")
		}
		frozen = append(frozen, item)
	}
	for cursor := frozenCursor; cursor != ""; {
		part, e := s.LocalDirectorySnapshot(ctx, cfg, "employees", cursor, 1, now.Add(2*time.Second))
		if e != nil || part.ChangesCursor != watermark {
			t.Fatal("snapshot lost frozen watermark", part, e)
		}
		for _, raw := range part.Items {
			var item LocalDirectoryIdentity
			if json.Unmarshal(raw, &item) != nil {
				t.Fatal("invalid frozen identity")
			}
			frozen = append(frozen, item)
		}
		cursor = part.NextCursor
	}
	found := false
	for _, item := range frozen {
		if item.Subject == first.ID {
			found = true
			if item.Name != "First local user" || item.State != "active" {
				t.Fatal("snapshot replaced by a later mutation", item)
			}
		}
	}
	if !found || len(frozen) != 3 {
		t.Fatal("snapshot dropped identities", len(frozen))
	}
	changes, err := s.LocalDirectoryChanges(ctx, cfg, watermark, 100, now.Add(3*time.Second))
	if err != nil || len(changes.Items) != 2 {
		t.Fatal("rights change not durable in feed", changes, err)
	}
	raw := string(encode(changes))
	if strings.Contains(raw, "fixture-private-password-material") || strings.Contains(raw, "password_hash") {
		t.Fatal("password material entered directory projection")
	}
	var changed map[string]json.RawMessage
	if json.Unmarshal(changes.Items[1], &changed) != nil {
		t.Fatal("invalid change DTO")
	}
	var changedIdentity LocalDirectoryIdentity
	if json.Unmarshal(changed["identity"], &changedIdentity) != nil || changedIdentity.State != "disabled" || changedIdentity.Subject != first.ID {
		t.Fatal("latest local rights absent from feed")
	}
	if _, err = s.LocalDirectorySnapshot(ctx, cfg, "departments", frozenCursor, 1, now); !errors.Is(err, ErrInvalid) {
		t.Fatal("cross-kind cursor accepted", err)
	}
	if _, err = s.LocalDirectorySnapshot(ctx, cfg, "employees", frozenCursor, 1, now.Add(16*time.Minute)); !errors.Is(err, ErrLocalDirectoryResync) {
		t.Fatal("expired snapshot accepted", err)
	}
	if _, err = s.LocalDirectoryIdentity(ctx, cfg, "ad:foreign", now); !errors.Is(err, ErrNotFound) {
		t.Fatal("AD subject entered local provider", err)
	}
	if _, err = s.LocalDirectoryChanges(ctx, cfg, "foreign_cursor", 100, now); !errors.Is(err, ErrInvalid) {
		t.Fatal("foreign change cursor accepted", err)
	}
}

func TestLocalDirectoryDisabledLoginModesAndMissingAccountRevoke(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	actor := model.User{ID: "local-admin", Admin: true}
	user, err := s.CreateLocalUser(ctx, actor, "localfixture", "Local fixture", "fixture-hash", false)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	cfg := LocalDirectoryConfig{UsersEnabled: true, BuiltinEnabled: true}
	active, err := s.LocalDirectoryIdentity(ctx, cfg, user.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	disabled, err := s.LocalDirectoryIdentity(ctx, LocalDirectoryConfig{BuiltinEnabled: true}, user.ID, now.Add(time.Second))
	if err != nil || disabled.State != "disabled" || disabled.Revision <= active.Revision {
		t.Fatal("disabled local login mode granted identity", disabled, err)
	}
	if _, err = s.Pool.Exec(ctx, "DELETE FROM local_users WHERE id=$1", user.ID); err != nil {
		t.Fatal(err)
	}
	missing, err := s.LocalDirectoryIdentity(ctx, cfg, user.ID, now.Add(2*time.Second))
	if err != nil || missing.State != "missing" || missing.Revision <= disabled.Revision {
		t.Fatal("missing local account retained active projection", missing, err)
	}
	builtin, err := s.LocalDirectoryIdentity(ctx, cfg, "local-admin", now)
	if err != nil || builtin.State != "active" || len(builtin.HeadDepartmentIDs) != 0 {
		t.Fatal("configured built-in administrator unavailable or elevated", builtin, err)
	}
	absent, err := s.LocalDirectoryIdentity(ctx, LocalDirectoryConfig{}, "local-admin", now.Add(3*time.Second))
	if err != nil || absent.State != "missing" || absent.Revision <= builtin.Revision {
		t.Fatal("removed built-in login retained identity", absent, err)
	}
}
