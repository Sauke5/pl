package server

import (
	"github.com/google/uuid"
	"strings"
)

func validWorkspaceGroupTile(id string) bool {
	if !strings.HasPrefix(id, "favorite-group_") {
		return false
	}
	_, err := uuid.Parse(strings.TrimPrefix(id, "favorite-group_"))
	return err == nil
}
