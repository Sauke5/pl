package organization

import (
	"context"
	"errors"
	"time"
)

const MaxADBatch = 1000
const ADReadTimeout = 15 * time.Second

type ADIdentity struct {
	Subject  string
	Revision uint64
	// Raw LDAP objectGUID binds the lookup to an existing identity, never login.
	ObjectGUID [16]byte
}

type ADObservation struct {
	Subject                string
	Name                   string
	AccountState           AccountState
	CandidateDepartmentIDs []string
	ObservedAt             time.Time
}

// ADSource must perform read-only lookups of the exact requested objects. A
// missing object is an explicit Missing observation; transport/search errors
// must return an error, not an empty membership or Missing observation. This
// package does not implement credentials, connections, discovery or scheduling.
type ADSource interface {
	ReadIdentities(context.Context, []ADIdentity) ([]ADObservation, error)
}

// ReadADBatch bounds one existing-identity read and rejects incomplete/foreign
// results before a caller can persist any observation. Implementations must
// honor ctx cancellation and independently bound LDAP response size.
func ReadADBatch(ctx context.Context, source ADSource, identities []ADIdentity) ([]ADObservation, error) {
	if source == nil || len(identities) == 0 || len(identities) > MaxADBatch {
		return nil, errors.New("invalid AD source or batch size")
	}
	want := make(map[string]bool, len(identities))
	guids := make(map[[16]byte]bool, len(identities))
	for _, identity := range identities {
		if identity.Subject == "" || len(identity.Subject) > 256 || want[identity.Subject] || identity.ObjectGUID == [16]byte{} || guids[identity.ObjectGUID] {
			return nil, errors.New("invalid or duplicate AD identity")
		}
		want[identity.Subject] = true
		guids[identity.ObjectGUID] = true
	}
	ctx, cancel := context.WithTimeout(ctx, ADReadTimeout)
	defer cancel()
	// Protect caller-owned request slices against an adapter mutating them.
	observations, err := source.ReadIdentities(ctx, append([]ADIdentity(nil), identities...))
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(observations) != len(identities) {
		return nil, errors.New("incomplete AD observation batch")
	}
	seen := make(map[string]bool, len(observations))
	for _, observation := range observations {
		if !want[observation.Subject] || seen[observation.Subject] || observation.ObservedAt.IsZero() {
			return nil, errors.New("invalid AD observation identity or timestamp")
		}
		switch observation.AccountState {
		case Active, Disabled, Expired, Missing:
		default:
			return nil, errors.New("AD observation must have confirmed account state")
		}
		seen[observation.Subject] = true
	}
	return observations, nil
}
