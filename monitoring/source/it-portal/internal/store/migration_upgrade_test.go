package store

import (
	"context"
	"encoding/json"
	"testing"

	migrations "pl/portal/db"
	"pl/portal/internal/model"
)

func TestRelationTypesMigrationPreservesExplicitSettingsAndLocalUsers(t *testing.T) {
	script, err := migrations.Migrations.ReadFile("migrations/012_dictionary_relation_types.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"legacy", "empty", "custom"} {
		t.Run(scenario, func(t *testing.T) {
			s := testStore(t)
			ctx := context.Background()
			body := map[string]any{"directions": []string{"Custom"}, "sites": []string{}, "environments": []string{"Lab"}, "types": []string{"Application"}}
			if scenario == "empty" {
				body["relation_types"] = []string{}
			}
			if scenario == "custom" {
				body["relation_types"] = []string{"Custom relation"}
			}
			data, _ := json.Marshal(body)
			// testStore installs defaults first. Replace only the dictionary fixture
			// with its pre-migration representation, retaining the real schema/users.
			if _, err = s.Pool.Exec(ctx, "UPDATE documents SET revision=5,body=$1 WHERE kind='dictionaries' AND id='global'", data); err != nil {
				t.Fatal(err)
			}
			if _, err = s.Pool.Exec(ctx, "INSERT INTO local_users(id,username,name,admin,password_hash) VALUES('local:22222222-2222-4222-8222-222222222222','fixture','Local fixture',false,'fixture-hash-preserve')"); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				if _, err = s.Pool.Exec(ctx, string(script)); err != nil {
					t.Fatal(err)
				}
			}
			current, err := Get[model.Dictionaries](ctx, s, "dictionaries", "global")
			if err != nil {
				t.Fatal(err)
			}
			expected := []string{"Размещено на", "Использует БД", "Зависит от", "Резервируется на"}
			revision, audits := int64(6), 1
			if scenario == "empty" {
				expected = []string{}
				revision, audits = 5, 0
			}
			if scenario == "custom" {
				expected = []string{"Custom relation"}
				revision, audits = 5, 0
			}
			if current.Revision != revision || len(current.RelationTypes) != len(expected) || len(current.Directions) != 1 || current.Directions[0] != "Custom" {
				t.Fatal("migration changed unrelated dictionary state", current)
			}
			for i, value := range expected {
				if current.RelationTypes[i] != value {
					t.Fatal("relation types not preserved", current.RelationTypes)
				}
			}
			var count int
			if err = s.Pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE body#>>'{details,migration}'='012_dictionary_relation_types'").Scan(&count); err != nil || count != audits {
				t.Fatal("migration audit is not idempotent", count, err)
			}
			var name, hash string
			var admin, disabled bool
			if err = s.Pool.QueryRow(ctx, "SELECT name,password_hash,admin,disabled FROM local_users WHERE username='fixture'").Scan(&name, &hash, &admin, &disabled); err != nil || name != "Local fixture" || hash != "fixture-hash-preserve" || admin || disabled {
				t.Fatal("migration changed local account", err)
			}
		})
	}
}
