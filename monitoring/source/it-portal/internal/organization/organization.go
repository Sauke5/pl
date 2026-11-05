// Package organization defines the Platform-owned employee and organizational
// facts. It does not grant access to application content or create login sessions.
package organization

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"sort"
	"strings"
	"time"
)

const (
	DefaultSyncInterval = 10 * time.Minute
	DefaultMaxFreshness = 2 * time.Hour
)

// ADSubject preserves the existing ad_auth.go subject byte-for-byte. objectGUID
// is the raw LDAP value, not the Windows formatted GUID string. A provider must
// retain its original baseDN namespace when its search base is reconfigured.
func ADSubject(baseDN string, objectGUID []byte) (string, error) {
	if strings.TrimSpace(baseDN) == "" || len(objectGUID) != 16 {
		return "", errors.New("AD identity requires namespace and 16 raw GUID bytes")
	}
	namespace := sha256.Sum256([]byte(strings.ToLower(baseDN)))
	return "ad:" + hex.EncodeToString(namespace[:])[:16] + ":" + hex.EncodeToString(objectGUID), nil
}

type DepartmentState string

const (
	Unassigned DepartmentState = "unassigned"
	Ambiguous  DepartmentState = "ambiguous"
	Resolved   DepartmentState = "resolved"
)

type Selection struct {
	DepartmentID string `json:"department_id"`
	SelectedBy   string `json:"selected_by"`
}

type DepartmentResolution struct {
	State               DepartmentState `json:"state"`
	PrimaryDepartmentID *string         `json:"primary_department_id"`
	CandidateIDs        []string        `json:"candidate_ids"`
	ExplicitSelection   *Selection      `json:"explicit_selection,omitempty"`
}

func canonicalIDs(ids []string) []string {
	result := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		if id != "" && !seen[id] {
			seen[id] = true
			result = append(result, id)
		}
	}
	sort.Strings(result)
	return result
}

// ResolveDepartment accepts only membership-confirmed candidates. A previously
// explicit choice survives only while it remains one of those candidates.
// Multiple mapped AD groups for the same department count as one candidate.
func ResolveDepartment(candidateIDs []string, previous *Selection) DepartmentResolution {
	ids := canonicalIDs(candidateIDs)
	r := DepartmentResolution{State: Unassigned, CandidateIDs: ids}
	if previous != nil && previous.SelectedBy != "" {
		i := sort.SearchStrings(ids, previous.DepartmentID)
		if i < len(ids) && ids[i] == previous.DepartmentID {
			choice := *previous
			r.ExplicitSelection = &choice
			r.PrimaryDepartmentID = &choice.DepartmentID
			r.State = Resolved
			return r
		}
	}
	if len(ids) == 1 {
		primary := ids[0]
		r.PrimaryDepartmentID = &primary
		r.State = Resolved
	} else if len(ids) > 1 {
		r.State = Ambiguous
	}
	return r
}

// SelectPrimary records an administrator's explicit choice. Authentication and
// administrator authorization belong to the caller; membership is checked here.
func SelectPrimary(candidateIDs []string, departmentID, actor string) (DepartmentResolution, error) {
	if departmentID == "" || actor == "" {
		return DepartmentResolution{}, errors.New("department and selecting actor required")
	}
	r := ResolveDepartment(candidateIDs, &Selection{DepartmentID: departmentID, SelectedBy: actor})
	if r.ExplicitSelection == nil {
		return DepartmentResolution{}, errors.New("primary department must be a current membership candidate")
	}
	return r, nil
}

type AccountState string

const (
	Active   AccountState = "active"
	Disabled AccountState = "disabled"
	Expired  AccountState = "expired"
	Missing  AccountState = "missing"
	Unknown  AccountState = "unknown"
)

// Identity is a durable Platform fact snapshot. Source errors never overwrite
// LastSuccessAt or turn unobserved membership into an empty successful result.
// HeadDepartmentIDs are metadata; they confer no project-content permission.
type Identity struct {
	Subject           string               `json:"subject"`
	Name              string               `json:"name"`
	Revision          uint64               `json:"identity_revision"`
	AccountState      AccountState         `json:"account_state"`
	Department        DepartmentResolution `json:"department"`
	HeadDepartmentIDs []string             `json:"head_department_ids"`
	LastSuccessAt     time.Time            `json:"last_success_at"`
}

type Projection struct {
	Identity
	Fresh              bool      `json:"fresh"`
	ValidUntil         time.Time `json:"identity_valid_until"`
	AccessAllowed      bool      `json:"access_allowed"`
	DepartmentEligible bool      `json:"department_eligible"`
}

// Project separates known account state from observation freshness. At the
// deadline access stops; unknown/future timestamps fail closed. Clock skew is
// not silently added to the configured maximum age.
func Project(identity Identity, now time.Time, maxAge time.Duration) Projection {
	identity.Department = ResolveDepartment(identity.Department.CandidateIDs, identity.Department.ExplicitSelection)
	identity.HeadDepartmentIDs = canonicalIDs(identity.HeadDepartmentIDs)
	p := Projection{Identity: identity}
	if !identity.LastSuccessAt.IsZero() && maxAge > 0 && maxAge <= DefaultMaxFreshness {
		p.ValidUntil = identity.LastSuccessAt.Add(maxAge)
		p.Fresh = !now.IsZero() && !identity.LastSuccessAt.After(now) && now.Before(p.ValidUntil)
	}
	validIdentity := strings.TrimSpace(identity.Subject) != "" && strings.TrimSpace(identity.Name) != "" && identity.Revision > 0
	p.AccessAllowed = validIdentity && p.Fresh && identity.AccountState == Active
	p.DepartmentEligible = p.AccessAllowed && identity.Department.State == Resolved && identity.Department.PrimaryDepartmentID != nil
	return p
}

// ChangeEvent is an outbox payload, not delivery. Store the new Identity and
// event in one PostgreSQL transaction; allocate its delivery cursor there.
// Consumers apply only increasing Revision and resynchronize on cursor gaps.
type ChangeEvent struct {
	EventID              string    `json:"event_id"`
	Type                 string    `json:"type"`
	OccurredAt           time.Time `json:"occurred_at"`
	PreviousDepartmentID *string   `json:"previous_department_id"`
	Identity             Identity  `json:"identity"`
}

// PrepareChange produces a complete state/outbox write plan. Successful refresh
// timestamps alone do not advance the authorization revision. No event means
// the refreshed Identity must still be saved by the caller.
func PrepareChange(previous *Identity, next Identity, eventID string, now time.Time) (Identity, *ChangeEvent, error) {
	if next.Subject == "" || next.Name == "" || now.IsZero() {
		return Identity{}, nil, errors.New("identity subject, name and change time required")
	}
	if previous != nil && previous.Subject != next.Subject {
		return Identity{}, nil, errors.New("identity subject cannot change")
	}
	switch next.AccountState {
	case Active, Disabled, Expired, Missing, Unknown:
	default:
		return Identity{}, nil, errors.New("invalid account state")
	}
	next.Department = ResolveDepartment(next.Department.CandidateIDs, next.Department.ExplicitSelection)
	next.HeadDepartmentIDs = canonicalIDs(next.HeadDepartmentIDs)
	next.Revision = 1
	if previous != nil {
		next.Revision = previous.Revision
		old := *previous
		old.Department = ResolveDepartment(old.Department.CandidateIDs, old.Department.ExplicitSelection)
		old.HeadDepartmentIDs = canonicalIDs(old.HeadDepartmentIDs)
		old.LastSuccessAt = next.LastSuccessAt
		if reflect.DeepEqual(old, next) {
			return next, nil, nil
		}
		if previous.Revision == ^uint64(0) {
			return Identity{}, nil, errors.New("identity revision exhausted")
		}
		next.Revision++
	}
	if eventID == "" {
		return Identity{}, nil, errors.New("event ID required for identity change")
	}
	event := &ChangeEvent{EventID: eventID, Type: "identity.changed", OccurredAt: now, Identity: next}
	if previous != nil && previous.Department.PrimaryDepartmentID != nil {
		id := *previous.Department.PrimaryDepartmentID
		event.PreviousDepartmentID = &id
	}
	return next, event, nil
}
