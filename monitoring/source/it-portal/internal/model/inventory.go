package model

import "time"

// InventoryObject is a read-only source observation, never a replacement for manual resource fields.
type InventoryObject struct {
	Kind      string             `json:"kind"`
	ObjectID  int64              `json:"object_id"`
	Name      string             `json:"name"`
	Role      string             `json:"role"`
	Platform  string             `json:"platform"`
	Site      string             `json:"site"`
	Status    string             `json:"status"`
	Hostname  string             `json:"hostname"`
	PrimaryIP string             `json:"primary_ip"`
	Addresses []InventoryAddress `json:"addresses"`
	NetBoxURL string             `json:"netbox_url"`
}
type InventoryAddress struct {
	DNSName        string `json:"dns_name"`
	Address        string `json:"address"`
	VRFID          *int64 `json:"vrf_id"`
	VRFName        string `json:"vrf_name"`
	InterfaceID    int64  `json:"interface_id"`
	InterfaceName  string `json:"interface_name"`
	ManagementOnly bool   `json:"management_only"`
	ObservedOnly   bool   `json:"observed_only"`
}
type ResourceInventorySource struct {
	Observation     *TargetObservation `json:"observation,omitempty"`
	CandidateID     string             `json:"candidate_id"`
	IntegrationID   string             `json:"integration_id"`
	IntegrationName string             `json:"integration_name"`
	Kind            string             `json:"kind"`
	Status          string             `json:"status"`
	LastSeen        time.Time          `json:"last_seen"`
	Stale           bool               `json:"stale"`
	Name            string             `json:"name"`
	URL             string             `json:"url"`
	Labels          map[string]string  `json:"labels"`
	Inventory       *InventoryObject   `json:"inventory,omitempty"`
}
type ResourceInventory struct {
	ResourceID string                    `json:"resource_id"`
	Sources    []ResourceInventorySource `json:"sources"`
}

type TargetObservation struct {
	Health     string    `json:"health"`
	LastScrape time.Time `json:"last_scrape"`
	ScrapeURL  string    `json:"scrape_url"`
	Job        string    `json:"job"`
	Instance   string    `json:"instance"`
}
