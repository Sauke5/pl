package model

import "time"

// ModuleInstance separates an installation or API connection from catalog resources.
// Observations retain their last-success timestamp when a later probe fails.
type ModuleInstance struct {
	SFTPGoDraft             *SFTPGoConfiguration       `json:"sftpgo_draft,omitempty"`
	SFTPGoApplied           *SFTPGoConfiguration       `json:"sftpgo_applied,omitempty"`
	AlertmanagerDraft       *AlertmanagerConfiguration `json:"alertmanager_draft,omitempty"`
	AlertmanagerApplied     *AlertmanagerConfiguration `json:"alertmanager_applied,omitempty"`
	XrayDraft               *XrayConfiguration         `json:"xray_draft,omitempty"`
	XrayApplied             *XrayConfiguration         `json:"xray_applied,omitempty"`
	PrometheusDraft         *PrometheusConfiguration   `json:"prometheus_draft,omitempty"`
	PrometheusApplied       *PrometheusConfiguration   `json:"prometheus_applied,omitempty"`
	ConfigurationLastJobID  string                     `json:"configuration_last_job_id,omitempty"`
	ConfigurationError      string                     `json:"configuration_error,omitempty"`
	ConfigurationRolledBack bool                       `json:"configuration_rolled_back,omitempty"`
	IntegrationID           string                     `json:"integration_id"`
	ResourceID              string                     `json:"resource_id"`
	ID                      string                     `json:"id"`
	Revision                int64                      `json:"revision"`
	ModuleID                string                     `json:"module_id"`
	Name                    string                     `json:"name"`
	Mode                    string                     `json:"mode"`
	Endpoint                string                     `json:"endpoint"`
	DesiredState            string                     `json:"desired_state"`
	ObservedState           string                     `json:"observed_state"`
	Version                 string                     `json:"version"`
	TargetsUp               int                        `json:"targets_up"`
	TargetsTotal            int                        `json:"targets_total"`
	LastAttempt             *time.Time                 `json:"last_attempt"`
	LastSuccess             *time.Time                 `json:"last_success"`
	LastJobID               string                     `json:"last_job_id"`
	Error                   string                     `json:"error"`
}

type SFTPGoConfiguration struct {
	Ref      string `json:"configuration_ref"`
	Revision int64  `json:"revision"`
	Hash     string `json:"configuration_hash"`
	ListenIP string `json:"listen_ip"`
	Port     int    `json:"port"`
}

type ModuleRequest struct {
	ConnectionRevision    int64             `json:"connection_revision,omitempty"`
	SecretRef             string            `json:"secret_ref,omitempty"`
	Config                map[string]string `json:"config,omitempty"`
	ConfigurationRevision int64             `json:"configuration_revision,omitempty"`
	AdditionalInstance    bool              `json:"additional_instance,omitempty"`
	ConfirmName           string            `json:"confirm_name,omitempty"`
	ModuleID              string            `json:"module_id"`
	Name                  string            `json:"name"`
	Mode                  string            `json:"mode"`
	Endpoint              string            `json:"endpoint"`
}
