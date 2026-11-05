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

// DeliveryStatus is a projection of the finite, authenticated host protocol.
// Neither image references, download URLs nor executable arguments come from web.
type DeliveryStatus struct {
	CurrentVersion  string             `json:"current_version"`
	LatestVersion   string             `json:"latest_version"`
	UpdateAvailable bool               `json:"update_available"`
	CheckedAt       string             `json:"checked_at,omitempty"`
	Error           string             `json:"error,omitempty"`
	CoreAPI         int                `json:"core_api"`
	Modules         []DeliveryModule   `json:"modules"`
	Operation       *DeliveryOperation `json:"operation,omitempty"`
}
type DeliveryModule struct {
	ModuleID string `json:"module_id"`
	Version  string `json:"version"`
}
type DeliveryOperation struct {
	Kind        string `json:"kind,omitempty"`
	OperationID string `json:"operation_id"`
	Version     string `json:"version,omitempty"`
	Phase       string `json:"phase"`
	Error       string `json:"error,omitempty"`
	StartedAt   string `json:"started_at,omitempty"`
	FinishedAt  string `json:"finished_at,omitempty"`
}
type DeliveryUpgrade struct {
	Version     string `json:"version,omitempty"`
	OperationID string `json:"operation_id"`
}

func (m *Manager) Delivery(ctx context.Context, action string, upgrade *DeliveryUpgrade) (DeliveryStatus, error) {
	if m == nil {
		return DeliveryStatus{}, errors.New("Доставка обновлений недоступна")
	}
	c, ok := m.Controller.(interface {
		Delivery(context.Context, string, *DeliveryUpgrade) (DeliveryStatus, error)
	})
	if !ok {
		return DeliveryStatus{}, errors.New("Host controller не поддерживает доставку обновлений")
	}
	return c.Delivery(ctx, action, upgrade)
}

func (c *HostController) Delivery(ctx context.Context, action string, upgrade *DeliveryUpgrade) (DeliveryStatus, error) {
	var result DeliveryStatus
	if action != "status" && action != "check" && action != "upgrade" && action != "recover" {
		return result, errors.New("Неизвестная операция доставки")
	}
	var value any = struct{}{}
	if action == "upgrade" || action == "recover" {
		if upgrade == nil || !canonicalID(upgrade.OperationID) || action == "upgrade" && (len(upgrade.Version) == 0 || len(upgrade.Version) > 64) || action == "recover" && upgrade.Version != "" {
			return result, errors.New("Некорректная версия или идентификатор обновления")
		}
		value = upgrade
	} else if upgrade != nil {
		return result, errors.New("Лишние параметры доставки")
	}
	body, err := json.Marshal(value)
	if err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	path := "/v1/delivery/" + action
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(ts + "\nPOST\n" + path + "\n"))
	mac.Write(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller"+path, bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pl-Timestamp", ts)
	req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	res, err := c.client.Do(req)
	if err != nil {
		return result, controllerTransportError(ctx, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 65537))
	if err != nil || len(raw) > 65536 || res.StatusCode != http.StatusOK || json.Unmarshal(raw, &result) != nil || result.CoreAPI != 1 {
		return DeliveryStatus{}, errors.New("Host controller не подтвердил состояние доставки")
	}
	return result, nil
}
