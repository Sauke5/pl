package store

// ModuleCredential is transient preparation supplied by the authenticated API.
// Only its keyed digest participates in idempotency; Seal is invoked after the
// integration identity is known and its envelope is committed in the same TX.
type ModuleCredential struct {
	Fingerprint string                       `json:"-"`
	Origin      string                       `json:"-"`
	ApprovedIPs []string                     `json:"-"`
	Seal        func(string) ([]byte, error) `json:"-"`
}
