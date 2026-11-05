package model

// AlertmanagerConfiguration contains only public metadata. Notification URLs,
// tokens and SMTP/proxy credentials belong to immutable root-private plans.
type AlertmanagerConfiguration struct {
	Revision  int64                  `json:"revision"`
	Ref       string                 `json:"ref"`
	Route     AlertmanagerRoute      `json:"route"`
	Receivers []AlertmanagerReceiver `json:"receivers"`
}
type AlertmanagerRoute struct {
	Receiver       string `json:"receiver"`
	GroupWait      string `json:"group_wait"`
	GroupInterval  string `json:"group_interval"`
	RepeatInterval string `json:"repeat_interval"`
}
type AlertmanagerReceiver struct {
	Name        string            `json:"name"`
	Kind        string            `json:"kind"`
	EndpointSet bool              `json:"endpoint_set"`
	TokenSet    bool              `json:"token_set"`
	ChatID      int64             `json:"chat_id,omitempty"`
	Proxy       AlertmanagerProxy `json:"proxy"`
	SMTP        *AlertmanagerSMTP `json:"smtp,omitempty"`
}
type AlertmanagerProxy struct {
	Mode        string   `json:"mode"`
	URL         string   `json:"url"`
	Username    string   `json:"username"`
	PasswordSet bool     `json:"password_set"`
	NoProxy     []string `json:"no_proxy"`
	CASet       bool     `json:"ca_set"`
}
type AlertmanagerConfigurationInput struct {
	Revision  int64                       `json:"revision"`
	Ref       string                      `json:"ref,omitempty"`
	Route     AlertmanagerRoute           `json:"route"`
	Receivers []AlertmanagerReceiverInput `json:"receivers"`
}
type AlertmanagerReceiverInput struct {
	Name        string                 `json:"name"`
	Kind        string                 `json:"kind"`
	Endpoint    string                 `json:"endpoint,omitempty"`
	Token       string                 `json:"token,omitempty"`
	EndpointSet bool                   `json:"endpoint_set,omitempty"`
	TokenSet    bool                   `json:"token_set,omitempty"`
	ChatID      int64                  `json:"chat_id,omitempty"`
	Proxy       AlertmanagerProxyInput `json:"proxy"`
	SMTP        *AlertmanagerSMTPInput `json:"smtp,omitempty"`
}
type AlertmanagerProxyInput struct {
	ClearCA     bool     `json:"clear_ca,omitempty"`
	Mode        string   `json:"mode"`
	URL         string   `json:"url"`
	Username    string   `json:"username"`
	Password    string   `json:"password,omitempty"`
	PasswordSet bool     `json:"password_set,omitempty"`
	NoProxy     []string `json:"no_proxy"`
	CAPEM       string   `json:"ca_pem,omitempty"`
	CASet       bool     `json:"ca_set,omitempty"`
}
type AlertmanagerStatus struct {
	State   string `json:"state"`
	Version string `json:"version"`
}

func DefaultAlertmanagerConfiguration() AlertmanagerConfiguration {
	return AlertmanagerConfiguration{Route: AlertmanagerRoute{GroupWait: "30s", GroupInterval: "5m", RepeatInterval: "4h"}, Receivers: []AlertmanagerReceiver{}}
}

// SMTP is public connection metadata; the password is returned only as a flag.
type AlertmanagerSMTP struct {
	Smarthost   string   `json:"smarthost"`
	From        string   `json:"from"`
	To          []string `json:"to"`
	TLSMode     string   `json:"tls_mode"`
	Username    string   `json:"username"`
	PasswordSet bool     `json:"password_set"`
}
type AlertmanagerSMTPInput struct {
	Smarthost   string   `json:"smarthost"`
	From        string   `json:"from"`
	To          []string `json:"to"`
	TLSMode     string   `json:"tls_mode"`
	Username    string   `json:"username"`
	Password    string   `json:"password,omitempty"`
	PasswordSet bool     `json:"password_set,omitempty"`
}
