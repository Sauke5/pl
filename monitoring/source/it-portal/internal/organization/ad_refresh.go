package organization

import (
	"context"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ADRefreshPlan is a bounded, immutable read plan. MappingRevision is the last
// committed department event sequence; it is rechecked under the writer lock
// before any observations are applied. DN-only/name/head edits conservatively
// invalidate in-flight plans too. Sequence gaps have no meaning.
type ADRefreshPlan struct {
	Namespace       string
	MappingRevision int64
	Identities      []ADIdentity
	Groups          []DepartmentBinding
	NextSubject     string
}

type DepartmentBinding struct {
	DepartmentID string
	ObjectGUID   [16]byte
}

func mappingRevision(ctx context.Context, tx pgx.Tx) (int64, error) {
	var revision int64
	err := tx.QueryRow(ctx, `SELECT COALESCE(max(sequence),0) FROM org_outbox WHERE body->>'type'='department.changed'`).Scan(&revision)
	return revision, err
}

// ADPlan reads only already registered identities and explicitly configured
// department group mappings. It never enumerates arbitrary directory users.
// A nonempty subject selects that exact identity; otherwise after is a keyset.
func (s *Store) ADPlan(ctx context.Context, namespace, subject, after string, limit int) (ADRefreshPlan, error) {
	p := ADRefreshPlan{Namespace: namespace, Identities: []ADIdentity{}, Groups: []DepartmentBinding{}}
	if !validNamespace(namespace) || limit < 1 || limit > MaxADBatch || subject != "" && after != "" {
		return p, ErrInvalid
	}
	tx, err := beginWrite(ctx, s.pool)
	if err != nil {
		return p, err
	}
	defer tx.Rollback(ctx)
	p.MappingRevision, err = mappingRevision(ctx, tx)
	if err != nil {
		return p, err
	}
	rows, err := tx.Query(ctx, `SELECT g.department_id,g.object_guid FROM org_department_groups g
 JOIN org_departments d ON d.id=g.department_id WHERE d.active AND g.provider_namespace=$1
 ORDER BY g.department_id,g.object_guid LIMIT $2`, namespace, MaxADBatch+1)
	if err != nil {
		return p, err
	}
	for rows.Next() {
		var binding DepartmentBinding
		var guid []byte
		if err = rows.Scan(&binding.DepartmentID, &guid); err != nil {
			rows.Close()
			return p, err
		}
		copy(binding.ObjectGUID[:], guid)
		p.Groups = append(p.Groups, binding)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return p, err
	}
	if len(p.Groups) > MaxADBatch {
		return p, ErrInvalid
	}
	rows, err = tx.Query(ctx, `SELECT subject,object_guid,revision FROM org_employees WHERE provider='ad' AND provider_namespace=$1
 AND ($2='' OR subject=$2) AND subject>$3 ORDER BY subject LIMIT $4`, namespace, subject, after, limit+1)
	if err != nil {
		return p, err
	}
	for rows.Next() {
		var identity ADIdentity
		var guid []byte
		var revision int64
		if err = rows.Scan(&identity.Subject, &guid, &revision); err != nil {
			rows.Close()
			return p, err
		}
		copy(identity.ObjectGUID[:], guid)
		identity.Revision = uint64(revision)
		p.Identities = append(p.Identities, identity)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return p, err
	}
	if len(p.Identities) > limit {
		p.Identities = p.Identities[:limit]
		p.NextSubject = p.Identities[limit-1].Subject
	}
	if subject != "" && len(p.Identities) == 0 {
		return p, ErrNotFound
	}
	if err = tx.Commit(ctx); err != nil {
		return p, err
	}
	return p, nil
}

// RegisterADLogin records the GUID proved by the existing password bind. It
// does not refresh department facts or reactivate previously disabled identity.
// New identities remain unknown/stale until a complete service-read succeeds.
func (s *Store) RegisterADLogin(ctx context.Context, subject, name, namespace string, now time.Time) (Identity, error) {
	if !validText(subject) || !validText(name) || !validNamespace(namespace) || now.IsZero() {
		return Identity{}, ErrInvalid
	}
	prefix := "ad:" + namespace + ":"
	if !strings.HasPrefix(subject, prefix) {
		return Identity{}, ErrInvalid
	}
	guid, err := hex.DecodeString(strings.TrimPrefix(subject, prefix))
	if err != nil || len(guid) != 16 || hex.EncodeToString(guid) != strings.TrimPrefix(subject, prefix) {
		return Identity{}, ErrInvalid
	}
	tx, err := beginWrite(ctx, s.pool)
	if err != nil {
		return Identity{}, err
	}
	defer tx.Rollback(ctx)
	r, err := readEmployee(ctx, tx, subject)
	var previous *Identity
	if errors.Is(err, ErrNotFound) {
		r = EmployeeRecord{Provider: "ad", ProviderNamespace: namespace, ObjectGUID: guid, Identity: Identity{Subject: subject, Name: name, AccountState: Unknown, Department: ResolveDepartment(nil, nil)}}
	} else if err != nil {
		return Identity{}, err
	} else {
		old := r.Identity
		previous = &old
		r.Identity.Name = name
	}
	next, err := persistEmployee(ctx, tx, r, previous, "ad-login", now)
	if err != nil {
		return Identity{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Identity{}, err
	}
	return next, nil
}

// ApplyADObservations applies a complete exact-known or explicit-scope batch.
// Revision=0 in a plan is reserved for newly discovered GUIDs. A mapping race,
// stale employee revision, partial batch or timestamp regression aborts all rows.
// Missing objects retain old department metadata for history; access is denied
// by account state, rather than fabricating a department transfer.
func (s *Store) ApplyADObservations(ctx context.Context, p ADRefreshPlan, observations []ADObservation, actor string, now time.Time) ([]Identity, error) {
	if !validNamespace(p.Namespace) || len(p.Identities) == 0 || len(p.Identities) > MaxADBatch || len(observations) != len(p.Identities) || !validText(actor) || now.IsZero() {
		return nil, ErrInvalid
	}
	known := map[string]ADIdentity{}
	allowed := map[string]bool{}
	for _, g := range p.Groups {
		allowed[g.DepartmentID] = true
	}
	for _, id := range p.Identities {
		if id.Subject != "ad:"+p.Namespace+":"+hex.EncodeToString(id.ObjectGUID[:]) || known[id.Subject].Subject != "" {
			return nil, ErrInvalid
		}
		known[id.Subject] = id
	}
	seen := map[string]bool{}
	for _, o := range observations {
		if known[o.Subject].Subject == "" || seen[o.Subject] || o.ObservedAt.IsZero() || o.ObservedAt.After(now) {
			return nil, ErrInvalid
		}
		seen[o.Subject] = true
		switch o.AccountState {
		case Active, Disabled, Expired, Missing:
		default:
			return nil, ErrInvalid
		}
		if o.AccountState != Missing && !validText(o.Name) {
			return nil, ErrInvalid
		}
		for _, id := range o.CandidateDepartmentIDs {
			if !allowed[id] {
				return nil, ErrInvalid
			}
		}
	}
	tx, err := beginWrite(ctx, s.pool)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	epoch, err := mappingRevision(ctx, tx)
	if err != nil {
		return nil, err
	}
	if epoch != p.MappingRevision {
		return nil, ErrConflict
	}
	result := make([]Identity, 0, len(observations))
	for _, o := range observations {
		id := known[o.Subject]
		r, err := readEmployee(ctx, tx, o.Subject)
		var previous *Identity
		if errors.Is(err, ErrNotFound) {
			if id.Revision != 0 || o.AccountState == Missing {
				return nil, ErrConflict
			}
			r = EmployeeRecord{Provider: "ad", ProviderNamespace: p.Namespace, ObjectGUID: append([]byte(nil), id.ObjectGUID[:]...), Identity: Identity{Subject: o.Subject}}
		} else if err != nil {
			return nil, err
		} else {
			if r.Identity.Revision != id.Revision || o.ObservedAt.Before(r.Identity.LastSuccessAt) {
				return nil, ErrConflict
			}
			old := r.Identity
			previous = &old
		}
		if o.AccountState != Missing {
			r.Identity.Name = o.Name
			r.Identity.Department.CandidateIDs = canonicalIDs(o.CandidateDepartmentIDs)
		}
		r.Identity.AccountState = o.AccountState
		r.Identity.LastSuccessAt = o.ObservedAt
		next, err := persistEmployee(ctx, tx, r, previous, actor, now)
		if err != nil {
			return nil, err
		}
		result = append(result, next)
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
