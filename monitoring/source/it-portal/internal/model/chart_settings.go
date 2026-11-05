package model

type ChartSelection struct {
	ID            string `json:"id"`
	IntegrationID string `json:"integration_id"`
	DashboardUID  string `json:"dashboard_uid"`
	PanelID       int    `json:"panel_id"`
	Range         string `json:"range"`
}
type ChartSettings struct {
	Revision int64            `json:"revision"`
	Charts   []ChartSelection `json:"charts"`
}
