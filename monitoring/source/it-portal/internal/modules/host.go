package modules

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"
)

type HostStatus struct {
	Schema        int       `json:"schema"`
	Installation  string    `json:"installation"`
	Hostname      string    `json:"hostname"`
	Kernel        string    `json:"kernel"`
	CPUs          int       `json:"cpus"`
	LoadAverage   []float64 `json:"load_average"`
	UptimeSeconds float64   `json:"uptime_seconds"`
	ObservedAt    time.Time `json:"observed_at"`
	Memory        struct {
		TotalBytes     uint64 `json:"total_bytes"`
		AvailableBytes uint64 `json:"available_bytes"`
	} `json:"memory"`
	Storage struct {
		TotalBytes uint64 `json:"total_bytes"`
		UsedBytes  uint64 `json:"used_bytes"`
		FreeBytes  uint64 `json:"free_bytes"`
	} `json:"storage"`
}

func (m *Manager) HostStatus(ctx context.Context) (HostStatus, error) {
	if m == nil {
		return HostStatus{}, errors.New("Host controller недоступен")
	}
	controller, ok := m.Controller.(interface {
		HostStatus(context.Context) (HostStatus, error)
	})
	if !ok {
		return HostStatus{}, errors.New("Диагностика хоста недоступна в установленном controller")
	}
	return controller.HostStatus(ctx)
}
func (c *HostController) HostStatus(ctx context.Context) (HostStatus, error) {
	var result HostStatus
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	response, err := c.hostRequest(ctx, "/v1/host/status", []byte("{}"))
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16385))
	if err != nil || response.StatusCode != 200 || len(raw) > 16384 || json.Unmarshal(raw, &result) != nil {
		return HostStatus{}, errors.New("Host controller не подтвердил диагностику хоста")
	}
	if result.Schema != 1 || result.CPUs < 1 || result.CPUs > 4096 || len(result.LoadAverage) != 3 || result.Hostname == "" || result.Memory.TotalBytes == 0 || result.Memory.AvailableBytes > result.Memory.TotalBytes || result.Storage.TotalBytes == 0 || result.Storage.FreeBytes > result.Storage.TotalBytes || result.Storage.UsedBytes > result.Storage.TotalBytes || result.UptimeSeconds < 0 || result.ObservedAt.IsZero() || time.Since(result.ObservedAt) > 30*time.Second || time.Until(result.ObservedAt) > 5*time.Second {
		return HostStatus{}, errors.New("Некорректные данные диагностики хоста")
	}
	for _, load := range result.LoadAverage {
		if load < 0 {
			return HostStatus{}, errors.New("Некорректная нагрузка хоста")
		}
	}
	return result, nil
}

func (c *HostController) hostRequest(ctx context.Context, path string, body []byte) (*http.Response, error) {
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(timestamp + "\nPOST\n" + path + "\n"))
	mac.Write(body)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller"+path, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("Диагностика хоста недоступна")
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Pl-Timestamp", timestamp)
	request.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	response, err := c.client.Do(request)
	if err != nil {
		return nil, controllerTransportError(ctx, err)
	}
	return response, nil
}

const MaxHostLogArchiveBytes = 24 << 20

var ErrHostLogExportUnavailable = errors.New("host log export unavailable")
var ErrHostLogExportBusy = errors.New("host log export busy")

func (m *Manager) CopyHostLogArchive(ctx context.Context, since, until time.Time, dst io.Writer) (int64, error) {
	if m != nil {
		if controller, ok := m.Controller.(interface {
			CopyHostLogArchive(context.Context, time.Time, time.Time, io.Writer) (int64, error)
		}); ok {
			return controller.CopyHostLogArchive(ctx, since, until, dst)
		}
	}
	return 0, ErrHostLogExportUnavailable
}

func (c *HostController) CopyHostLogArchive(ctx context.Context, since, until time.Time, dst io.Writer) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 34*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]int64{"since": since.Unix(), "until": until.Unix()})
	response, err := c.hostRequest(ctx, "/v1/host/log-export", body)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests {
		return 0, ErrHostLogExportBusy
	}
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "application/zip" ||
		response.ContentLength <= 0 || response.ContentLength > MaxHostLogArchiveBytes {
		return 0, ErrHostLogExportUnavailable
	}
	n, err := io.Copy(dst, io.LimitReader(response.Body, response.ContentLength+1))
	if err != nil || n != response.ContentLength {
		return 0, ErrHostLogExportUnavailable
	}
	return n, nil
}
