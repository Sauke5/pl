package server

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/organization"
)

// InitDoska validates the optional integration before any routes are served.
func (s *Server) InitDoska() error {
	if s.Config.Doska == nil && s.Config.DoskaAD == nil {
		return nil
	}
	if s.Config.Doska == nil || s.Config.DoskaAD == nil || s.Store == nil {
		return errors.New("incomplete Doska integration")
	}
	source, err := NewDoskaADSource(*s.Config.DoskaAD)
	if err != nil {
		return err
	}
	syncer, err := NewDoskaDirectorySync(organization.NewStore(s.Store.Pool), source)
	if err != nil {
		return err
	}
	handler, err := s.DoskaGateway(*s.Config.Doska)
	if err != nil {
		return err
	}
	s.doskaHandler, s.doskaDirectorySync = handler, syncer
	return nil
}

func (s *Server) RunDoska(ctx context.Context) {
	if s.doskaDirectorySync != nil {
		s.doskaDirectorySync.Run(ctx)
	}
}

// A directory outage does not change Platform login. Doska separately requires
// confirmed, fresh directory facts and cannot use an unknown login as a grant.
func (s *Server) observeDoskaADLogin(parent context.Context, user model.User) {
	if s.doskaDirectorySync == nil {
		return
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	source := s.doskaDirectorySync.source
	org := organization.NewStore(s.Store.Pool)
	if _, err := org.RegisterADLogin(ctx, user.ID, user.Name, source.Namespace(), time.Now().UTC()); err != nil {
		slog.Warn("doska_login_observation_failed")
		return
	}
	if _, err := s.doskaDirectorySync.RefreshSubject(ctx, user.ID, time.Now().UTC()); err != nil {
		slog.Warn("doska_login_refresh_failed")
	}
}
