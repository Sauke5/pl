package providers

import (
	"context"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"pl/portal/internal/model"
	"pl/portal/internal/netguard"
	"strings"
	"testing"
)

func TestNetBoxInventoryAndCredentials(t *testing.T) {
	t.Setenv("PORTAL_SECRET_REFS", "env:PORTAL_SECRET_NB")
	t.Setenv("PORTAL_SECRET_NB", "private-test")
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.Header.Get("Authorization") != "Token private-test" {
			t.Error("missing Token auth")
		}
		if q.URL.Query().Get("limit") != "200" {
			t.Error("unbounded request")
		}
		records := "[]"
		switch q.URL.Path {
		case "/api/dcim/devices/":
			records = `[{"id":1,"name":"server.example","site":{"name":"Office"},"role":{"name":"Server"},"status":{"value":"active"},"primary_ip4":{"address":"10.0.0.1/24"}}]`
		case "/api/virtualization/virtual-machines/":
			records = `[{"id":1,"name":"vm.example"}]`
		case "/api/dcim/interfaces/":
			records = `[{"id":1,"name":"eth0","device":{"id":1}},{"id":2,"name":"BMC","device":{"id":1},"mgmt_only":true,"custom_fields":{"topology_observed_ip":"10.0.0.3","secret":"omit"}}]`
		case "/api/virtualization/interfaces/":
			records = `[{"id":1,"name":"ens18","virtual_machine":{"id":1}}]`
		case "/api/ipam/ip-addresses/":
			records = `[{"id":1,"address":"10.0.0.1/24","assigned_object_type":"dcim.interface","assigned_object_id":1},{"id":2,"address":"10.0.0.2/24","assigned_object_type":"dcim.interface","assigned_object_id":1,"vrf":{"id":7,"name":"private"}},{"id":3,"address":"10.0.0.1/24","assigned_object_type":"virtualization.vminterface","assigned_object_id":1,"vrf":{"id":8}}]`
		default:
			t.Error(q.URL.Path)
		}
		count := 1
		if strings.Contains(q.URL.Path, "ip-addresses") {
			count = 3
		}
		if q.URL.Path == "/api/dcim/interfaces/" {
			count = 2
		}
		fmt.Fprintf(w, `{"count":%d,"next":null,"results":%s}`, count, records)
	})
	s, e := r.Poll(context.Background(), model.Integration{Kind: "netbox", ID: "nb", URL: "http://test", SecretRef: "env:PORTAL_SECRET_NB"})
	if e != nil {
		t.Fatal(e)
	}
	if len(s.Candidates) != 2 {
		t.Fatal(s)
	}
	d := s.Candidates[0]
	if d.ExternalID != "dcim.device:1" || d.Inventory.Kind != "device" || len(d.Inventory.Addresses) != 3 || d.URL != "http://test/dcim/devices/1/" {
		t.Fatalf("bad device %+v", d)
	}
	if !d.Inventory.Addresses[0].ObservedOnly || !d.Inventory.Addresses[0].ManagementOnly || d.Inventory.Addresses[0].Address != "10.0.0.3" {
		t.Fatal(d.Inventory.Addresses)
	}
	if d.Inventory.Addresses[2].VRFID == nil || *d.Inventory.Addresses[2].VRFID != 7 {
		t.Fatal(d.Inventory.Addresses)
	}
	if s.Candidates[1].Inventory.Addresses[0].VRFID == nil || *s.Candidates[1].Inventory.Addresses[0].VRFID != 8 {
		t.Fatal("VRF identity lost")
	}
}
func TestNetBoxPaginationDoesNotFollowNext(t *testing.T) {
	calls := 0
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		calls++
		if q.URL.Path != "/api/dcim/devices/" {
			t.Fatal(q.URL)
		}
		if q.URL.Query().Get("offset") == "0" {
			fmt.Fprint(w, `{"count":2,"next":"http://evil.example/steal","results":[{"id":1}]}`)
		} else {
			fmt.Fprint(w, `{"count":2,"next":null,"results":[{"id":2}]}`)
		}
	})
	v, e := netboxList[nbObject](context.Background(), r, model.Integration{URL: "http://test"}, "/api/dcim/devices/", "token")
	if e != nil || len(v) != 2 || calls != 2 {
		t.Fatalf("%v %v %d", v, e, calls)
	}
}
func TestNetBoxFailuresNeverReturnPartialInventory(t *testing.T) {
	for _, body := range []string{`null`, `{"count":1,"results":[]}`, `{"count":20001,"results":[]}`, `{"count":0}`} {
		t.Run(body, func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				if q.URL.Path == "/api/dcim/devices/" {
					fmt.Fprint(w, `{"count":1,"results":[{"id":1,"name":"server"}]}`)
				} else {
					fmt.Fprint(w, body)
				}
			})
			s, e := r.Poll(context.Background(), model.Integration{Kind: "netbox", URL: "http://test"})
			if e == nil || len(s.Candidates) != 0 {
				t.Fatalf("partial/accepted %v %v", s, e)
			}
		})
	}
}
func TestNetBoxRefusesRedirect(t *testing.T) {
	calls := 0
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		calls++
		http.Redirect(w, q, "http://test/elsewhere", 302)
	})
	_, e := r.Poll(context.Background(), model.Integration{Kind: "netbox", URL: "http://test"})
	if e == nil || calls != 1 {
		t.Fatalf("redirect followed %v %d", e, calls)
	}
}

func TestNetBoxExplicitHTTPHost(t *testing.T) {
	r := registry(t, func(w http.ResponseWriter, q *http.Request) {
		if q.Host != "netbox.example" {
			t.Errorf("Host=%q", q.Host)
		}
		if q.Header.Get("Authorization") != "Token scoped" {
			t.Error("auth missing")
		}
		fmt.Fprint(w, `{"count":0,"results":[]}`)
	})
	_, e := netboxList[nbObject](context.Background(), r, model.Integration{URL: "http://test", Config: map[string]string{"http_host": "netbox.example"}}, "/api/dcim/devices/", "scoped")
	if e != nil {
		t.Fatal(e)
	}
	for _, host := range []string{"https://netbox.example", "netbox.example:443", "netbox.example/path", "user@netbox.example", "netbox.example\r\nX: x", "127.0.0.1", "-bad.example", "netbox..example"} {
		_, e = netboxList[nbObject](context.Background(), r, model.Integration{URL: "http://test", Config: map[string]string{"http_host": host}}, "/api/dcim/devices/", "scoped")
		if e == nil {
			t.Errorf("accepted invalid host %q", host)
		}
	}
}

func TestNetBoxHTTPHostKeepsURLTLSVerification(t *testing.T) {
	hits := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		hits++
		if q.Host != "netbox.example" || q.TLS.ServerName != "example.com" {
			t.Errorf("host=%s TLS=%s", q.Host, q.TLS.ServerName)
		}
		if q.Header.Get("Authorization") != "Token scoped" {
			t.Error("missing scoped token")
		}
		fmt.Fprint(w, `{"count":0,"results":[]}`)
	}))
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if e := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); e != nil {
		t.Fatal(e)
	}
	guard, e := netguard.NewWithDependencies([]string{"10.0.0.0/8"}, []int{443}, ca, fakeDNS{}, func(c context.Context, n, a string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(c, n, strings.TrimPrefix(server.URL, "https://"))
	})
	if e != nil {
		t.Fatal(e)
	}
	r := New(guard, "")
	i := model.Integration{URL: "https://example.com", Config: map[string]string{"http_host": "netbox.example"}}
	if _, e = netboxList[nbObject](context.Background(), r, i, "/api/dcim/devices/", "scoped"); e != nil {
		t.Fatal(e)
	}
	i.URL = "https://wrong-host.example"
	if _, e = netboxList[nbObject](context.Background(), r, i, "/api/dcim/devices/", "scoped"); e == nil {
		t.Fatal("URL hostname verification bypassed")
	}
	if hits != 1 {
		t.Fatalf("token sent before verified TLS: %d", hits)
	}
}

func TestNetBoxPrimaryAddressSelection(t *testing.T) {
	for _, tt := range []struct{ name, primary, want string }{
		{"IPv4 preferred", `"primary_ip4":{"address":"192.168.25.123/24"},"primary_ip6":{"address":"2001:db8::1/64"}`, "192.168.25.123"},
		{"IPv6 fallback", `"primary_ip4":null,"primary_ip6":{"address":"2001:db8::1/64"}`, "2001:db8::1"},
		{"no primary", `"primary_ip4":null,"primary_ip6":null`, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := registry(t, func(w http.ResponseWriter, q *http.Request) {
				if q.URL.Path == "/api/dcim/devices/" || q.URL.Path == "/api/virtualization/virtual-machines/" {
					fmt.Fprintf(w, `{"count":1,"results":[{"id":91,"name":"device",%s}]}`, tt.primary)
				} else {
					fmt.Fprint(w, `{"count":0,"results":[]}`)
				}
			})
			s, e := r.Poll(context.Background(), model.Integration{Kind: "netbox", ID: "source", URL: "http://test"})
			if e != nil {
				t.Fatal(e)
			}
			if len(s.Candidates) != 2 {
				t.Fatal(s)
			}
			for _, c := range s.Candidates {
				if c.Inventory.PrimaryIP != tt.want {
					t.Fatalf("%s IP=%q want %q", c.ExternalID, c.Inventory.PrimaryIP, tt.want)
				}
			}
			if s.Candidates[0].ExternalID == s.Candidates[1].ExternalID {
				t.Fatal("device and VM identities collapsed")
			}
		})
	}
}
