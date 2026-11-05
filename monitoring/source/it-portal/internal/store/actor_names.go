package store

import "context"

// ActorNames resolves only the requested identities; login audit snapshots keep
// names available after the corresponding sessions have ended.
func (s *Store) ActorNames(ctx context.Context, actors []string) (map[string]string, error) {
	result := make(map[string]string)
	if len(actors) == 0 {
		return result, nil
	}
	rows, err := s.Pool.Query(ctx, `
WITH candidates AS (
 SELECT user_id AS actor, user_name AS name, 0 AS priority, expires_at AS observed_at
 FROM sessions WHERE user_id=ANY($1::text[]) AND user_name<>''
 UNION ALL
 SELECT body->>'actor', body->>'actor_name', 1, created_at
 FROM audit_events WHERE body->>'actor'=ANY($1::text[]) AND COALESCE(body->>'actor_name','')<>''
 UNION ALL
 SELECT body->>'actor', body->>'actor_name', 1, created_at
 FROM events WHERE body->>'actor'=ANY($1::text[]) AND COALESCE(body->>'actor_name','')<>''
)
SELECT DISTINCT ON (actor) actor, name FROM candidates
ORDER BY actor, priority, observed_at DESC, name`, actors)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var actor, name string
		if err := rows.Scan(&actor, &name); err != nil {
			return nil, err
		}
		result[actor] = name
	}
	return result, rows.Err()
}
