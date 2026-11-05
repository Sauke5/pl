package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"pl/portal/internal/model"
)

func TestSFTPExchangeRouteRequiresAdminBrowserSession(t *testing.T) {
	st := localAuthTestStore(t)
	ctx := context.Background()
	for _, user := range []string{"admin", "viewer"} {
		_, err := st.Pool.Exec(ctx, "INSERT INTO sessions(token_hash,user_id,user_name,admin,csrf,expires_at) VALUES($1,$2,$2,$3,'csrf',now()+interval '1 hour')", hash(user), user, user == "admin")
		if err != nil {
			t.Fatal(err)
		}
	}
	collection, err := st.SFTPSaveCollection(ctx, model.SFTPCollection{Branch: "Branch", Label: "DBF", Folder: "branch", QuotaBytes: 1024}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	receivedAt := time.Now().Add(-time.Minute).UTC()
	if _, err = st.SFTPReceiveRemote(ctx, model.SFTPVersion{CollectionID: collection.ID, Filename: "archive.zip", SizeBytes: 7, SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ReceivedAt: receivedAt, ReceivedBy: "branch-sender", ReceivedByName: "Branch sender"}, "/collections/"+collection.ID+"/archive.zip", "exchange-route-receipt"); err != nil {
		t.Fatal(err)
	}

	s := &Server{Store: st, Config: Config{PublicURL: "http://localhost"}}
	mux := s.Handler()
	call := func(user, authorization string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/sftp-exchange", nil)
		if user != "" {
			r.AddCookie(&http.Cookie{Name: "portal_session", Value: user})
		}
		if authorization != "" {
			r.Header.Set("Authorization", authorization)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if got := call("", ""); got.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status=%d body=%s", got.Code, got.Body)
	}
	if got := call("viewer", ""); got.Code != http.StatusForbidden {
		t.Fatalf("viewer status=%d body=%s", got.Code, got.Body)
	}
	if got := call("admin", "Bearer machine"); got.Code != http.StatusUnauthorized {
		t.Fatalf("machine authorization inherited status=%d body=%s", got.Code, got.Body)
	}
	got := call("admin", "")
	if got.Code != http.StatusOK {
		t.Fatalf("admin status=%d body=%s", got.Code, got.Body)
	}
	var state model.SFTPExchangeState
	if err = json.Unmarshal(got.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	if state.ObservedAt.IsZero() || state.Provider.Configured || state.Provider.Status != "disabled" || len(state.Branches) != 1 {
		t.Fatalf("unexpected state: %+v", state)
	}
	branch := state.Branches[0]
	if branch.ID != collection.ID || branch.ReceivedCount != 1 || branch.LastReceived == nil || branch.LastReceived.Filename != "archive.zip" || branch.LastReceived.Sender != "Branch sender" || branch.LastReceived.Availability != "available" {
		t.Fatalf("receipt projection: %+v", branch)
	}
}
