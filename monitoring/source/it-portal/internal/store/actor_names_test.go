package store

import (
	"context"
	"testing"
)

func TestActorNamesUsesSessionThenAudit(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Pool.Exec(ctx, `
 INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at)
 VALUES('actor-name-test','ad:known','Текущее имя',true,'fixture',now()+interval '1 hour');
 INSERT INTO audit_events(id,body) VALUES
 ('actor-audit','{"actor":"ad:known","actor_name":"Имя из журнала"}'),
 ('actor-other','{"actor":"ad:other","actor_name":"Другой пользователь"}');`)
	if err != nil {
		t.Fatal(err)
	}
	names, err := s.ActorNames(ctx, []string{"ad:known", "ad:missing"})
	if err != nil || len(names) != 1 || names["ad:known"] != "Текущее имя" {
		t.Fatalf("names=%v err=%v", names, err)
	}
	if _, err = s.Pool.Exec(ctx, "DELETE FROM sessions WHERE user_id='ad:known'"); err != nil {
		t.Fatal(err)
	}
	names, err = s.ActorNames(ctx, []string{"ad:known"})
	if err != nil || names["ad:known"] != "Имя из журнала" {
		t.Fatalf("names=%v err=%v", names, err)
	}
}
