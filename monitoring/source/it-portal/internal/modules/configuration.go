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
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"pl/portal/internal/model"
)

var configName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]{0,127}$`)
var configLabel = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
var configDuration = regexp.MustCompile(`^[1-9][0-9]{0,7}(ms|s|m|h)$`)
var configHostname = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
var configAddress = regexp.MustCompile(`^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9][A-Za-z0-9.-]*):[0-9]{1,5}$`)
var configPath = regexp.MustCompile(`^/[A-Za-z0-9/_%.~:@!$&()*+,;=-]{0,255}$`)

func ValidateConfiguration(c model.PrometheusConfiguration) error {
	encoded, _ := json.Marshal(c)
	if len(encoded) > 256<<10 {
		return errors.New("Конфигурация превышает 256 КиБ")
	}
	if c.Revision < 0 || c.Revision > (1<<53)-1 || c.Jobs == nil || len(c.Jobs) > 64 {
		return errors.New("Допускается до 64 jobs; ревизия не может быть отрицательной")
	}
	duration := func(interval, timeout string) error {
		i, ie := time.ParseDuration(interval)
		t, te := time.ParseDuration(timeout)
		if !configDuration.MatchString(interval) || !configDuration.MatchString(timeout) || ie != nil || te != nil || i < time.Second || i > 24*time.Hour || t < time.Second || t > i {
			return errors.New("Интервал: от 1s до 24h; timeout: от 1s до интервала сбора")
		}
		return nil
	}
	if err := duration(c.Global.ScrapeInterval, c.Global.ScrapeTimeout); err != nil {
		return err
	}
	names := map[string]bool{"prometheus": true}
	total := 0
	for _, j := range c.Jobs {
		if !configName.MatchString(j.Name) || names[j.Name] {
			return errors.New("Недопустимое или повторное имя job; prometheus зарезервировано")
		}
		names[j.Name] = true
		if err := duration(j.ScrapeInterval, j.ScrapeTimeout); err != nil {
			return err
		}
		if j.Scheme != "http" && j.Scheme != "https" {
			return errors.New("Scheme должен быть http или https")
		}
		if !configPath.MatchString(j.MetricsPath) {
			return errors.New("Metrics path должен быть ASCII-путём / без query и fragment")
		}
		if len(j.Targets) == 0 {
			return errors.New("Добавьте хотя бы один target для каждого job")
		}
		addresses := map[string]bool{}
		for _, target := range j.Targets {
			total++
			if total > 512 {
				return errors.New("Допускается до 512 targets")
			}
			host, port, err := net.SplitHostPort(target.Address)
			n, pe := strconv.Atoi(port)
			if !configAddress.MatchString(target.Address) || err != nil || pe != nil || n < 1 || n > 65535 || len(target.Address) > 256 || host == "" || strings.ContainsAny(target.Address, "/?#@\\ \t\r\n") || addresses[target.Address] {
				return errors.New("Target должен быть уникальным адресом host:port или [IPv6]:port")
			}
			if strings.Contains(host, ":") {
				if net.ParseIP(host) == nil {
					return errors.New("Некорректный IPv6 target")
				}
			} else {
				if len(host) > 253 {
					return errors.New("Некорректное имя target")
				}
				for _, part := range strings.Split(strings.TrimSuffix(host, "."), ".") {
					if !configHostname.MatchString(part) {
						return errors.New("Некорректное имя target")
					}
				}
			}
			addresses[target.Address] = true
			if target.Labels == nil || len(target.Labels) > 32 {
				return errors.New("Допускается до 32 labels на target")
			}
			for k, v := range target.Labels {
				if !configLabel.MatchString(k) || strings.HasPrefix(k, "__") || k == "job" || k == "instance" || len(v) > 1024 || !utf8.ValidString(v) || strings.ContainsFunc(v, func(r rune) bool { return r < 32 || r == 127 }) {
					return errors.New("Некорректный label; job, instance и __* зарезервированы")
				}
			}
		}
	}
	return nil
}

type ConfigurationValidation struct {
	InstanceID string `json:"instance_id"`
	Valid      bool   `json:"valid"`
	YAML       string `json:"yaml"`
	Hash       string `json:"hash"`
}
type ConfigurationValidator interface {
	ValidateConfiguration(context.Context, string, model.PrometheusConfiguration) (ConfigurationValidation, error)
}

func (c *HostController) ValidateConfiguration(ctx context.Context, id string, configuration model.PrometheusConfiguration) (ConfigurationValidation, error) {
	var out ConfigurationValidation
	if !canonicalID(id) {
		return out, errors.New("Некорректный ID модуля")
	}
	if err := ValidateConfiguration(configuration); err != nil {
		return out, err
	}
	body, _ := json.Marshal(map[string]any{"instance_id": id, "configuration": configuration})
	path := "/v1/configuration/validate"
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, c.key)
	mac.Write([]byte(ts + "\nPOST\n" + path + "\n"))
	mac.Write(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://module-controller"+path, bytes.NewReader(body))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Pl-Timestamp", ts)
	req.Header.Set("X-Pl-Signature", hex.EncodeToString(mac.Sum(nil)))
	res, err := c.client.Do(req)
	if err != nil {
		return out, controllerTransportError(ctx, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return out, err
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(data, &out) != nil || out.InstanceID != id || !out.Valid || len(out.Hash) != 64 || len(out.YAML) > 1<<20 {
		return out, errors.New("Host controller не подтвердил проверку конфигурации; проверьте jobs и targets")
	}
	sum := sha256.Sum256([]byte(out.YAML))
	if hex.EncodeToString(sum[:]) != out.Hash {
		return out, errors.New("Host controller вернул несовпадающий hash конфигурации")
	}
	return out, nil
}
