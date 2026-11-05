package model

import (
	"embed"
	"encoding/json"
)

// Shared with the frontend picker; only shipped SVG keys are accepted.
//
//go:embed resource-icons.json
var resourceIconFiles embed.FS

var resourceIconKeys = func() []string {
	raw, err := resourceIconFiles.ReadFile("resource-icons.json")
	if err != nil {
		panic(err)
	}
	var choices []struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(raw, &choices); err != nil {
		panic(err)
	}
	keys := make([]string, 0, len(choices))
	for _, choice := range choices {
		keys = append(keys, choice.Key)
	}
	return keys
}()

func ResourceIconKeys() []string { return append([]string(nil), resourceIconKeys...) }

func ValidResourceIcon(key string) bool {
	if key == "" || key == "auto" {
		return true
	}
	for _, candidate := range resourceIconKeys {
		if key == candidate {
			return true
		}
	}
	return false
}
