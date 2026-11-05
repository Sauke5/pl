package model

// XrayConfiguration is public metadata only. Credentials live in an immutable
// root-private plan identified by Ref and never enter documents or durable jobs.
type XrayConfiguration struct {
	Revision int64         `json:"revision"`
	Ref      string        `json:"ref"`
	Inbounds []XrayInbound `json:"inbounds"`
	Outbound XrayOutbound  `json:"outbound"`
	Routing  string        `json:"routing"`
}
type XrayInbound struct {
	Tag         string `json:"tag"`
	Protocol    string `json:"protocol"`
	Listen      string `json:"listen"`
	Port        int    `json:"port"`
	Auth        string `json:"auth"`
	Username    string `json:"username"`
	PasswordSet bool   `json:"password_set"`
}
type XrayOutbound struct {
	Mode     string `json:"mode"`
	Protocol string `json:"protocol"`
	Server   string `json:"server"`
	Port     int    `json:"port"`
	Name     string `json:"name"`
}
type XrayConfigurationInput struct {
	Revision int64              `json:"revision"`
	Ref      string             `json:"ref,omitempty"`
	Inbounds []XrayInboundInput `json:"inbounds"`
	Outbound XrayOutboundInput  `json:"outbound"`
	Routing  string             `json:"routing"`
}
type XrayInboundInput struct {
	Tag         string `json:"tag"`
	Protocol    string `json:"protocol"`
	Listen      string `json:"listen"`
	Port        int    `json:"port"`
	Auth        string `json:"auth"`
	Username    string `json:"username"`
	Password    string `json:"password,omitempty"`
	PasswordSet bool   `json:"password_set,omitempty"`
}
type XrayOutboundInput struct {
	Mode string `json:"mode"`
	Link string `json:"link,omitempty"`
}
type XrayStatus struct {
	State    string              `json:"state"`
	Version  string              `json:"version"`
	Inbounds []XrayInboundStatus `json:"inbounds"`
	Outbound XrayOutbound        `json:"outbound"`
	Routing  string              `json:"routing"`
	Counters []XrayCounter       `json:"counters"`
}
type XrayInboundStatus struct {
	Tag      string `json:"tag"`
	Protocol string `json:"protocol"`
	Listen   string `json:"listen"`
	Port     int    `json:"port"`
}
type XrayCounter struct {
	Name  string `json:"name"`
	Value int64  `json:"value"`
}

func DefaultXrayConfiguration() XrayConfiguration {
	return XrayConfiguration{Inbounds: []XrayInbound{}, Outbound: XrayOutbound{Mode: "direct"}, Routing: "proxy_all"}
}
