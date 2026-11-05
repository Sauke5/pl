package providers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"pl/portal/internal/model"
	"time"
)

type manifestReport struct {
	Type    string `json:"report_type"`
	File    string `json:"file"`
	Date    string `json:"date"`
	Run     int    `json:"run"`
	ISOYear int    `json:"iso_year"`
	ISOWeek int    `json:"iso_week"`
	Start   string `json:"period_start"`
	End     string `json:"period_end"`
}

func (r *Registry) reportManifest(ctx context.Context, i model.Integration) ([]model.Report, error) {
	base := i.Config["reports_base_url"]
	if base == "" {
		base = i.URL
	}
	u, e := url.Parse(base)
	if e != nil || !safeSourceURL(base) {
		return nil, errors.New("invalid report public URL")
	}
	// Read the index over the internal generator connection. Public report URLs
	// remain on the archive origin, where each browser request needs a session.
	manifestURL, e := url.Parse(i.URL)
	if e != nil || !safeSourceURL(i.URL) {
		return nil, errors.New("invalid report generator URL")
	}
	manifestURL.Path = "/internal/reports/manifest"
	manifestURL.RawPath = ""
	manifestURL.RawQuery = ""
	manifestURL.Fragment = ""
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, manifestURL.String(), nil)
	if e != nil {
		return nil, errors.New("invalid report manifest request")
	}
	client := r.guard.Client(timeout(i))
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, e := client.Do(req)
	if e != nil {
		return nil, errors.New("report manifest unavailable (network, policy or TLS)")
	}
	var entries []manifestReport
	if e = decode(resp, &entries); e != nil {
		return nil, e
	}
	if entries == nil || len(entries) > 10000 {
		return nil, errors.New("invalid report manifest")
	}
	reports := make([]model.Report, 0, len(entries))
	seen := map[string]bool{}
	for _, entry := range entries {
		if entry.Run < 1 {
			return nil, errors.New("invalid report run")
		}
		var expected, period, title string
		switch entry.Type {
		case "daily":
			date, err := time.Parse("2006-01-02", entry.Date)
			if err != nil || date.Format("2006-01-02") != entry.Date {
				return nil, errors.New("invalid daily report date")
			}
			expected = fmt.Sprintf("infrastructure-%s-run-%d.html", entry.Date, entry.Run)
			period = entry.Date
			title = fmt.Sprintf("Ежедневный отчёт · %s · №%d", period, entry.Run)
		case "weekly":
			start, err := time.Parse("2006-01-02", entry.Start)
			end, endErr := time.Parse("2006-01-02", entry.End)
			year, week := start.ISOWeek()
			endYear, endWeek := end.ISOWeek()
			if err != nil || endErr != nil || end.Before(start) || year != entry.ISOYear || week != entry.ISOWeek || endYear != year || endWeek != week {
				return nil, errors.New("invalid weekly report period")
			}
			expected = fmt.Sprintf("infrastructure-weekly-%04d-W%02d-run-%d.html", year, week, entry.Run)
			period = entry.Start + " — " + entry.End
			title = fmt.Sprintf("Недельный отчёт · %04d-W%02d · №%d", year, week, entry.Run)
		default:
			return nil, errors.New("unsupported report type")
		}
		// Exact filename construction rejects traversal, encoded separators, query,
		// absolute URLs and disagreement between file and manifest metadata.
		if entry.File != expected {
			return nil, errors.New("invalid report filename")
		}
		u.Path = "/reports/" + entry.File
		address := u.String()
		if seen[address] {
			continue
		}
		seen[address] = true
		reports = append(reports, model.Report{URL: address, Title: title, Period: period, Status: "succeeded", Run: entry.Run, ReportType: entry.Type})
	}
	return reports, nil
}
