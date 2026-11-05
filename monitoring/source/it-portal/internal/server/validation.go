package server

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"pl/portal/internal/model"
	"pl/portal/internal/modules"
	"pl/portal/internal/providers"
	"pl/portal/internal/store"
)

func safeURL(v string) bool {
	u, e := url.Parse(v)
	return e == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil && !strings.ContainsAny(v, "\r\n\x00") && len(v) <= 4096 && !sensitiveQuery(u)
}
func sensitiveQuery(u *url.URL) bool {
	for k := range u.Query() {
		switch strings.ToLower(k) {
		case "token", "access_token", "id_token", "password", "secret", "api_key", "apikey", "authorization":
			return true
		}
	}
	return false
}
func validateResource(r *model.Resource) error {
	if !model.ValidResourceIcon(r.Icon) {
		return errors.New("Неизвестная иконка карточки")
	}
	r.Name = strings.TrimSpace(r.Name)
	if r.Name == "" || utf8.RuneCountInString(r.Name) > 160 || (r.URL == "" && !store.IsHostResource(*r)) || (r.URL != "" && !safeURL(r.URL)) {
		return errors.New("Укажите название до 160 символов. Для приложения нужен HTTP(S)-адрес без credentials и секретов; для оборудования адрес необязателен")
	}
	if err := validateEmployeeMetadata(r.Employee); err != nil {
		return err
	}
	if r.URL == "" && strings.TrimSpace(r.Hostname) == "" && r.IP == "" {
		return errors.New("Для оборудования без адреса входа укажите имя узла или IP")
	}
	if len(r.Description) > 10000 || len(r.Hostname) > 253 || len(r.Type) > 100 || len(r.Site) > 100 || len(r.Environment) > 100 {
		return errors.New("Слишком длинное поле ресурса")
	}
	if r.IP != "" && net.ParseIP(r.IP) == nil {
		return errors.New("Некорректный IP")
	}
	if r.Lifecycle == "" {
		r.Lifecycle = "active"
	}
	if r.Lifecycle != "active" && r.Lifecycle != "archived" {
		return errors.New("Некорректное состояние записи")
	}
	for _, list := range [][]string{r.Aliases, r.Directions, r.Tags, r.ExternalIDs, r.Operations} {
		if len(list) > 100 {
			return errors.New("Слишком много значений")
		}
		for _, v := range list {
			if len(v) > 512 {
				return errors.New("Слишком длинное значение")
			}
		}
	}
	if len(r.Endpoints) > 50 || len(r.Links) > 50 || len(r.Relations) > 100 {
		return errors.New("Слишком много связей")
	}
	for _, ep := range append(append([]model.Endpoint{}, r.Endpoints...), r.Links...) {
		if !safeURL(ep.URL) || len(ep.Name) > 160 {
			return errors.New("Некорректная ссылка")
		}
	}
	for _, rel := range r.Relations {
		if _, e := uuid.Parse(rel.ResourceID); e != nil || len(rel.Label) > 160 || rel.ResourceID == r.ID {
			return errors.New("Некорректная связь ресурса")
		}
	}
	for _, op := range r.Operations {
		if !store.Contains([]string{"check", "report", "restart"}, op) {
			return errors.New("Неизвестная операция")
		}
	}
	if store.Contains(r.Operations, "restart") && r.ExecutorTarget == "" {
		return errors.New("Для restart требуется явно заданная цель executor")
	}
	if r.ExecutorTarget != "" && !regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`).MatchString(r.ExecutorTarget) {
		return errors.New("Некорректный идентификатор executor")
	}
	if r.Check.Kind != "" && !store.Contains([]string{"dns", "tcp", "http", "tls"}, r.Check.Kind) {
		return errors.New("Неизвестный тип проверки")
	}
	if r.Check.IntervalSeconds != 0 && (r.Check.IntervalSeconds < 30 || r.Check.IntervalSeconds > 86400) {
		return errors.New("Интервал проверки: 30–86400 секунд")
	}
	if r.Check.IntervalSeconds > 0 {
		if err := providers.ValidateCheckTarget(r.Check.Kind, providers.ResourceCheckTarget(*r)); err != nil {
			return err
		}
	}
	if r.Aliases == nil {
		r.Aliases = []string{}
	}
	if r.Directions == nil {
		r.Directions = []string{}
	}
	if r.Tags == nil {
		r.Tags = []string{}
	}
	if r.Endpoints == nil {
		r.Endpoints = []model.Endpoint{}
	}
	if r.Links == nil {
		r.Links = []model.Endpoint{}
	}
	if r.Relations == nil {
		r.Relations = []model.Relation{}
	}
	if r.ExternalIDs == nil {
		r.ExternalIDs = []string{}
	}
	if r.Operations == nil {
		r.Operations = []string{}
	}
	return nil
}
func validateIntegration(i *model.Integration) error {
	if !store.Contains([]string{"prometheus", "alertmanager", "grafana", "reports", "docker", "wayline", "fileauditor", "netbox", "oxidized"}, i.Kind) {
		return errors.New("Неизвестная интеграция")
	}
	if i.Kind == "fileauditor" {
		normalized, err := modules.ValidateAuditorEndpoint(i.URL)
		if err != nil {
			return err
		}
		if !strings.HasPrefix(i.SecretRef, "file:") || i.SecretRef == "file:" {
			return errors.New("File Auditor требует ссылку file: на ключ шлюза v2")
		}
		i.URL = normalized
	}
	i.Name = strings.TrimSpace(i.Name)
	if i.Name == "" || len(i.Name) > 160 {
		return errors.New("Укажите название интеграции")
	}
	if i.Kind != "docker" && !safeURL(i.URL) {
		return errors.New("Укажите HTTP(S)-адрес интеграции без секретов")
	}
	if i.PollSeconds == 0 {
		i.PollSeconds = 60
	}
	if i.TimeoutSeconds == 0 {
		i.TimeoutSeconds = 10
	}
	if i.Concurrency == 0 {
		i.Concurrency = 1
	}
	if i.PollSeconds < 10 || i.PollSeconds > 86400 || i.TimeoutSeconds < 1 || i.TimeoutSeconds > 300 || i.Concurrency < 1 || i.Concurrency > 4 {
		return errors.New("Проверьте интервал, timeout и параллелизм")
	}
	if i.SecretRef != "" && !strings.HasPrefix(i.SecretRef, "env:PORTAL_SECRET_") && !strings.HasPrefix(i.SecretRef, "file:") {
		return errors.New("Используйте ссылку env:PORTAL_SECRET_* или file:имя")
	}
	allowed := map[string]bool{"dashboard_url": true, "reports_base_url": true, "instance_label": true, "resource_label": true, "include_job": true, "exclude_job": true, "match_label": true, "match_value": true, "discovery_enabled": true}
	for k, v := range i.Config {
		if i.Kind == "oxidized" && (k == "gitea_repository_url" || k == "gitea_branch" || k == "node_bindings") {
			continue
		}
		if i.Kind == "netbox" && k == "http_host" {
			if v != "" && (!regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`).MatchString(v) || strings.Contains(v, "..")) {
				return errors.New("Укажите только DNS-имя NetBox для reverse proxy")
			}
			continue
		}
		if i.Kind == "netbox" && k == "public_url" {
			if v != "" && !safeURL(v) {
				return errors.New("Некорректная ссылка NetBox")
			}
			continue
		}
		if i.Kind == "wayline" && (k == "basic_username" || k == "stale_after_seconds" || k == "public_url") {
			if k == "basic_username" && (v == "" || len(v) > 160 || strings.ContainsAny(v, ":\r\n")) {
				return errors.New("Некорректное имя пользователя Wayline")
			}
			if k == "public_url" && !safeURL(v) {
				return errors.New("Некорректная ссылка Wayline")
			}
			if k == "stale_after_seconds" {
				n, err := strconv.Atoi(v)
				if err != nil || n < 30 || n > 86400 {
					return errors.New("Порог устаревания: 30–86400 секунд")
				}
			}
			continue
		}
		if !allowed[k] || len(v) > 2048 {
			return fmt.Errorf("Недопустимый параметр интеграции: %s", k)
		}
		if strings.HasSuffix(k, "url") && !safeURL(v) {
			return errors.New("Некорректная ссылка интеграции")
		}
		if k == "discovery_enabled" && (i.Kind != "prometheus" || v != "true" && v != "false") {
			return errors.New("Обнаружение Prometheus принимает true или false")
		}
	}
	if i.Config == nil {
		i.Config = map[string]string{}
	}
	if i.Kind == "wayline" && ((i.Config["basic_username"] == "") != (i.SecretRef == "")) {
		return errors.New("Для Wayline укажите имя пользователя и ссылку на пароль вместе")
	}
	if i.Kind == "oxidized" {
		if err := model.ValidateOxidizedConfig(i.Config); err != nil {
			return errors.New("Проверьте репозиторий Gitea, ветку и соответствия устройств")
		}
	}
	return nil
}
func validateSettings(v model.Settings) error {
	if v.SessionLifetimeMinutes != 0 && (v.SessionLifetimeMinutes < 15 || v.SessionLifetimeMinutes > 10080) {
		return errors.New("Срок сессии: 15–10080 минут")
	}
	if v.LocalPasswordMinLength != 0 && (v.LocalPasswordMinLength < 8 || v.LocalPasswordMinLength > 128) {
		return errors.New("Минимальная длина пароля: 8–128 символов")
	}
	if _, e := time.LoadLocation(v.Timezone); e != nil {
		return errors.New("Неизвестный часовой пояс")
	}
	if v.StaleAfterSeconds < 30 || v.StaleAfterSeconds > 86400 {
		return errors.New("Порог устаревания: 30–86400 секунд")
	}
	if len(v.BoardTitle) > 160 || len(v.BoardResourceIDs) > 1000 {
		return errors.New("Слишком большой board")
	}
	if v.BoardAnonymous && !v.BoardEnabled {
		return errors.New("Сначала включите board")
	}
	return nil
}
