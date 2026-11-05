package model

import "time"

type SFTPExchangeReceipt struct {
	ID           string    `json:"id"`
	Filename     string    `json:"filename"`
	SizeBytes    int64     `json:"size_bytes"`
	ReceivedAt   time.Time `json:"received_at"`
	Sender       string    `json:"sender"`
	Availability string    `json:"availability"`
}

type SFTPExchangeBranch struct {
	LastReceived  *SFTPExchangeReceipt `json:"last_received"`
	ID            string               `json:"id"`
	Branch        string               `json:"branch"`
	Label         string               `json:"label"`
	Folder        string               `json:"folder"`
	ReceivedCount int64                `json:"received_count"`
}

type SFTPExchangeState struct {
	ObservedAt time.Time            `json:"observed_at"`
	Provider   SFTPProviderState    `json:"provider"`
	Branches   []SFTPExchangeBranch `json:"branches"`
}
