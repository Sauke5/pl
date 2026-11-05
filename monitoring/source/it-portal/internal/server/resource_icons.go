package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"pl/portal/internal/model"
)

func parseResourceIcon(raw json.RawMessage) (string, error) {
	var icon string
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &icon) != nil || icon == "" || !model.ValidResourceIcon(icon) {
		return "", errors.New("Выберите известную иконку карточки или автоматический выбор")
	}
	if icon == "auto" {
		return "", nil
	}
	return icon, nil
}
