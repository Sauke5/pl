package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"pl/portal/internal/model"
	"pl/portal/internal/store"
)

type marketingTarget struct {
	IntegrationID string `json:"integration_id"`
	Instance      string `json:"instance"`
}
type problemPresentation struct {
	Revision    int64             `json:"revision"`
	ResourceIDs []string          `json:"resource_ids"`
	Targets     []marketingTarget `json:"targets"`
}
type presentedProblem struct {
	model.Problem
	Marketing bool `json:"marketing"`
}

func (s *Server) registerProblemPresentationRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/problem-presentation", s.auth(s.problemPresentation, true))
	m.HandleFunc("PUT /api/v1/problem-presentation", s.auth(s.problemPresentation, true))
	m.HandleFunc("GET /api/v1/workspace-problems", s.auth(s.presentedProblems, true))
}

func canonicalProblemTarget(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	u.Host = strings.ToLower(u.Host)
	if u.Port() == "80" && u.Scheme == "http" || u.Port() == "443" && u.Scheme == "https" {
		u.Host = strings.ToLower(u.Hostname())
		if strings.Contains(u.Host, ":") {
			u.Host = "[" + u.Host + "]"
		}
	}
	u.Fragment = ""
	if u.Path == "" {
		u.Path = "/"
	}
	return u.String()
}

func marketingProblem(p model.Problem, policy problemPresentation) bool {
	// Explicit identity only: WebsiteDown also applies to internal apps.
	for _, id := range policy.ResourceIDs {
		if id == p.ResourceID {
			return true
		}
		for _, linked := range p.ResourceIDs {
			if id == linked {
				return true
			}
		}
	}
	instance := canonicalProblemTarget(p.Labels["instance"])
	if instance == "" {
		return false
	}
	for _, target := range policy.Targets {
		if target.IntegrationID == p.IntegrationID && canonicalProblemTarget(target.Instance) == instance {
			return true
		}
	}
	return false
}

func (s *Server) readProblemPresentation(r *http.Request) (problemPresentation, error) {
	v, err := store.Get[problemPresentation](r.Context(), s.Store, "problem_presentation", "global")
	if errors.Is(err, store.ErrNotFound) {
		return problemPresentation{ResourceIDs: []string{}, Targets: []marketingTarget{}}, nil
	}
	return v, err
}

func (s *Server) problemPresentation(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		v, err := s.readProblemPresentation(r)
		if err != nil {
			s.fail(w, err)
			return
		}
		respond(w, 200, v)
		return
	}
	var v problemPresentation
	if !decode(w, r, &v) {
		return
	}
	if !uniqueWorkspaceIDs(v.ResourceIDs, 1000) || len(v.Targets) > 1000 {
		problem(w, 400, "invalid_presentation", "Слишком много объектов")
		return
	}
	seen := map[string]bool{}
	for index, target := range v.Targets {
		address := canonicalProblemTarget(target.Instance)
		if target.IntegrationID == "" || len(target.IntegrationID) > 128 || address == "" || len(address) > 2048 || seen[target.IntegrationID+"\x00"+address] {
			problem(w, 400, "invalid_presentation", "Нужны уникальные адреса сайтов и их источники")
			return
		}
		seen[target.IntegrationID+"\x00"+address] = true
		v.Targets[index].Instance = address
	}
	if v.ResourceIDs == nil {
		v.ResourceIDs = []string{}
	}
	if v.Targets == nil {
		v.Targets = []marketingTarget{}
	}
	out, err := s.Store.Save(r.Context(), "problem_presentation", "global", v.Revision, v, current(r).User.ID)
	if err != nil {
		s.fail(w, err)
		return
	}
	if err = json.Unmarshal(out, &v); err != nil {
		s.fail(w, err)
		return
	}
	s.Hub.Notify("problems")
	respond(w, 200, v)
}

func (s *Server) presentedProblems(w http.ResponseWriter, r *http.Request) {
	policy, err := s.readProblemPresentation(r)
	if err != nil {
		s.fail(w, err)
		return
	}
	problems, err := s.Store.Problems(r.Context())
	if err != nil {
		s.fail(w, err)
		return
	}
	out := make([]presentedProblem, 0, len(problems))
	for _, p := range problems {
		out = append(out, presentedProblem{p, marketingProblem(p, policy)})
	}
	respond(w, 200, out)
}
