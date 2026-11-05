package model

// PrometheusConfiguration is the finite static-scrape configuration owned by Pl.
// The protected self-scrape is generated separately and cannot be edited here.
type PrometheusConfiguration struct {
	Revision int64                 `json:"revision"`
	Global   PrometheusGlobal      `json:"global"`
	Jobs     []PrometheusScrapeJob `json:"jobs"`
}
type PrometheusGlobal struct {
	ScrapeInterval string `json:"scrape_interval"`
	ScrapeTimeout  string `json:"scrape_timeout"`
}
type PrometheusScrapeJob struct {
	Name           string                   `json:"name"`
	Enabled        bool                     `json:"enabled"`
	ScrapeInterval string                   `json:"scrape_interval"`
	ScrapeTimeout  string                   `json:"scrape_timeout"`
	MetricsPath    string                   `json:"metrics_path"`
	Scheme         string                   `json:"scheme"`
	Targets        []PrometheusScrapeTarget `json:"targets"`
}
type PrometheusScrapeTarget struct {
	Address string            `json:"address"`
	Labels  map[string]string `json:"labels"`
}

func DefaultPrometheusConfiguration() PrometheusConfiguration {
	return PrometheusConfiguration{Global: PrometheusGlobal{ScrapeInterval: "15s", ScrapeTimeout: "10s"}, Jobs: []PrometheusScrapeJob{}}
}
