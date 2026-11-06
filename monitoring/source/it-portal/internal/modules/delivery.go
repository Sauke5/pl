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
	CurrentVersion  string                `json:"current_version"`
	LatestVersion   string                `json:"latest_version"`
	UpdateAvailable bool                  `json:"update_available"`
	CheckedAt       string                `json:"checked_at,omitempty"`
	Error           string                `json:"error,omitempty"`
	CoreAPI         int                   `json:"core_api"`
	Modules         []DeliveryModule      `json:"modules"`
	Operation       *DeliveryOperation    `json:"operation,omitempty"`
	ReleaseNotes    *DeliveryReleaseNotes `json:"release_notes,omitempty"`
}

// DeliveryReleaseNotes contains only the public release description validated
// against the signed catalog by the host controller. Older controllers may omit it.
type DeliveryReleaseNotes struct {
	Version  string                   `json:"version"`
	Title    string                   `json:"title"`
	Summary  string                   `json:"summary"`
	Sections []DeliveryReleaseSection `json:"sections"`
}

type DeliveryReleaseSectionKind string

const (
	DeliveryReleaseNew      DeliveryReleaseSectionKind = "new"
	DeliveryReleaseImproved DeliveryReleaseSectionKind = "improved"
	DeliveryReleaseFixed    DeliveryReleaseSectionKind = "fixed"
)

type DeliveryReleaseSection struct {
	Kind  DeliveryReleaseSectionKind `json:"kind"`
	Items []DeliveryReleaseItem      `json:"items"`
}

type DeliveryReleaseItem struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

type DeliveryModule struct {
	ModuleID         string `json:"module_id"`
	Version          string `json:"version"`
	Installed        bool   `json:"installed,omitempty"`
	InstalledVersion string `json:"installed_version,omitempty"`
	UpdateAvailable  bool   `json:"update_available,omitempty"`
	UpgradeSupported bool   `json:"upgrade_supported,omitempty"`
	ArtifactSHA256   string `json:"artifact_sha256,omitempty"`
	BlockedReason    string `json:"blocked_reason,omitempty"`
}
type DeliveryOperation struct {
	Kind             string `json:"kind,omitempty"`
	Scope            string `json:"scope,omitempty"`
	ModuleID         string `json:"module_id,omitempty"`
	RecoveryMode     string `json:"recovery_mode,omitempty"`
	RestoredSnapshot bool   `json:"restored_snapshot,omitempty"`
	OperationID      string `json:"operation_id"`
	Version          string `json:"version,omitempty"`
	Phase            string `json:"phase"`
	Error            string `json:"error,omitempty"`
	StartedAt        string `json:"started_at,omitempty"`
	FinishedAt       string `json:"finished_at,omitempty"`
}
type DeliveryUpgrade struct {
	Version        string `json:"version,omitempty"`
	OperationID    string `json:"operation_id"`
	ModuleID       string `json:"module_id,omitempty"`
	ArtifactSHA256 string `json:"artifact_sha256,omitempty"`
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
	if action != "status" && action != "check" && action != "upgrade" && action != "recover" && action != "module-upgrade" {
		return result, errors.New("Неизвестная операция доставки")
	}
	var value any = struct{}{}
	if action == "upgrade" || action == "recover" || action == "module-upgrade" {
		if upgrade == nil || !canonicalID(upgrade.OperationID) {
			return result, errors.New("Некорректная версия или идентификатор обновления")
		}
		if action == "module-upgrade" {
			digest, err := hex.DecodeString(upgrade.ArtifactSHA256)
			if !deliveredModule(upgrade.ModuleID) || upgrade.Version != "" || err != nil || len(digest) != sha256.Size || hex.EncodeToString(digest) != upgrade.ArtifactSHA256 {
				return result, errors.New("Некорректный модуль или контрольная сумма поставки")
			}
		} else if upgrade.ModuleID != "" || upgrade.ArtifactSHA256 != "" || action == "upgrade" && (len(upgrade.Version) == 0 || len(upgrade.Version) > 64) || action == "recover" && upgrade.Version != "" {
			return result, errors.New("Некорректные параметры обновления")
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

func deliveredModule(id string) bool {
	switch id {
	case "prometheus", "xray", "alertmanager", "wayline", "grafana", "forms", "doska", "sftpgo", "netmap", "bookstack":
		return true
	default:
		return false
	}
}
