package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"pl/portal/internal/model"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type nbRef struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	Display string `json:"display"`
	Value   string `json:"value"`
	Label   string `json:"label"`
	Address string `json:"address"`
}

func (v nbRef) text() string {
	for _, s := range []string{v.Name, v.Label, v.Display, v.Value} {
		if s != "" {
			return s
		}
	}
	return ""
}

type nbObject struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Site       nbRef  `json:"site"`
	Role       nbRef  `json:"role"`
	Platform   nbRef  `json:"platform"`
	Status     nbRef  `json:"status"`
	PrimaryIP4 nbRef  `json:"primary_ip4"`
	PrimaryIP6 nbRef  `json:"primary_ip6"`
}
type nbInterface struct {
	ID             int64                      `json:"id"`
	Name           string                     `json:"name"`
	Device         nbRef                      `json:"device"`
	VM             nbRef                      `json:"virtual_machine"`
	ManagementOnly bool                       `json:"mgmt_only"`
	CustomFields   map[string]json.RawMessage `json:"custom_fields"`
}
type nbIP struct {
	ID           int64  `json:"id"`
	Address      string `json:"address"`
	DNSName      string `json:"dns_name"`
	VRF          *nbRef `json:"vrf"`
	AssignedType string `json:"assigned_object_type"`
	AssignedID   *int64 `json:"assigned_object_id"`
}

// NetBox pagination never follows the source's next URL. Each request is rebuilt
// against the configured origin and fixed collection path, with one poll deadline.
func netboxList[T any](ctx context.Context, r *Registry, i model.Integration, path, token string) ([]T, error) {
	// The optional HTTP Host routes an explicitly configured reverse proxy vhost.
	// The URL still controls DNS, network policy and TLS certificate verification.
	host := i.Config["http_host"]
	if host != "" && !validNetBoxHTTPHost(host) {
		return nil, errors.New("invalid NetBox HTTP host")
	}
	var result []T
	expectedCount := -1
	for page := 0; page < 100; page++ {
		u, e := endpoint(i.URL, path)
		if e != nil {
			return nil, e
		}
		parsed, _ := url.Parse(u)
		q := parsed.Query()
		q.Set("limit", "200")
		q.Set("offset", strconv.Itoa(len(result)))
		parsed.RawQuery = q.Encode()
		req, e := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
		if e != nil {
			return nil, errors.New("invalid NetBox request")
		}
		if token != "" {
			req.Header.Set("Authorization", "Token "+token)
		}
		req.Header.Set("Accept", "application/json")
		if host != "" {
			req.Host = host
		}
		client := r.guard.Client(timeout(i))
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		resp, e := client.Do(req)
		if e != nil {
			return nil, errors.New("NetBox request failed (network, policy or TLS)")
		}
		var v struct {
			Count   *int            `json:"count"`
			Next    json.RawMessage `json:"next"`
			Results *[]T            `json:"results"`
		}
		if e = decode(resp, &v); e != nil {
			return nil, e
		}
		if v.Count == nil || v.Results == nil || *v.Count < 0 || *v.Count > 20000 || len(*v.Results) > 200 {
			return nil, errors.New("invalid or oversized NetBox collection")
		}
		if expectedCount < 0 {
			expectedCount = *v.Count
		} else if expectedCount != *v.Count {
			return nil, errors.New("NetBox collection changed during pagination; retry")
		}
		result = append(result, (*v.Results)...)
		if len(result) > *v.Count {
			return nil, errors.New("inconsistent NetBox collection")
		}
		if len(result) == *v.Count {
			return result, nil
		}
		if len(*v.Results) == 0 {
			return nil, errors.New("incomplete NetBox collection")
		}
	}
	return nil, errors.New("NetBox pagination limit exceeded")
}
func (r *Registry) pollNetBox(ctx context.Context, i model.Integration) (model.Snapshot, error) {
	empty := model.Snapshot{Candidates: []model.Candidate{}, Problems: []model.Problem{}}
	ctx, cancel := context.WithTimeout(ctx, timeout(i))
	defer cancel()
	token, e := secret(i.SecretRef)
	if e != nil {
		return empty, e
	}
	devices, e := netboxList[nbObject](ctx, r, i, "/api/dcim/devices/", token)
	if e != nil {
		return empty, e
	}
	vms, e := netboxList[nbObject](ctx, r, i, "/api/virtualization/virtual-machines/", token)
	if e != nil {
		return empty, e
	}
	interfaces, e := netboxList[nbInterface](ctx, r, i, "/api/dcim/interfaces/", token)
	if e != nil {
		return empty, e
	}
	vmInterfaces, e := netboxList[nbInterface](ctx, r, i, "/api/virtualization/interfaces/", token)
	if e != nil {
		return empty, e
	}
	ips, e := netboxList[nbIP](ctx, r, i, "/api/ipam/ip-addresses/", token)
	if e != nil {
		return empty, e
	}
	publicURL := i.URL
	if configured := strings.TrimSpace(i.Config["public_url"]); configured != "" {
		if !safeSourceURL(configured) {
			return empty, errors.New("invalid NetBox public URL")
		}
		publicURL = configured
	}
	objects := map[string]*model.InventoryObject{}
	order := []string{}
	for index, list := range [][]nbObject{devices, vms} {
		kind, path := "dcim.device", "/dcim/devices/"
		if index == 1 {
			kind, path = "virtualization.virtualmachine", "/virtualization/virtual-machines/"
		}
		for _, v := range list {
			key := fmt.Sprintf("%s:%d", kind, v.ID)
			if v.ID <= 0 || strings.TrimSpace(v.Name) == "" || objects[key] != nil {
				return empty, errors.New("invalid or duplicate NetBox object")
			}
			objectURL, _ := endpoint(publicURL, path+strconv.FormatInt(v.ID, 10)+"/")
			primary := v.PrimaryIP4.Address
			if primary == "" {
				primary = v.PrimaryIP6.Address
			}
			primary = nbAddress(primary)
			inventoryKind := "device"
			if index == 1 {
				inventoryKind = "virtual_machine"
			}
			objects[key] = &model.InventoryObject{Kind: inventoryKind, ObjectID: v.ID, Name: v.Name, Hostname: v.Name, Role: v.Role.text(), Platform: v.Platform.text(), Site: v.Site.text(), Status: v.Status.Value, PrimaryIP: primary, Addresses: []model.InventoryAddress{}, NetBoxURL: objectURL}
			order = append(order, key)
		}
	}
	type assignment struct {
		object *model.InventoryObject
		iface  nbInterface
	}
	assignments := map[string]assignment{}
	for index, list := range [][]nbInterface{interfaces, vmInterfaces} {
		kind, ifaceKind := "dcim.device", "dcim.interface"
		if index == 1 {
			kind, ifaceKind = "virtualization.virtualmachine", "virtualization.vminterface"
		}
		for _, v := range list {
			parent := v.Device.ID
			if index == 1 {
				parent = v.VM.ID
			}
			key := fmt.Sprintf("%s:%d", ifaceKind, v.ID)
			if v.ID <= 0 {
				return empty, errors.New("invalid NetBox interface")
			}
			if _, exists := assignments[key]; exists {
				return empty, errors.New("duplicate NetBox interface")
			}
			object := objects[fmt.Sprintf("%s:%d", kind, parent)]
			assignments[key] = assignment{object, v}
			if object == nil {
				continue
			}
			var observed string
			if raw := v.CustomFields["topology_observed_ip"]; len(raw) > 0 {
				_ = json.Unmarshal(raw, &observed)
			}
			if net.ParseIP(strings.TrimSpace(observed)) != nil {
				object.Addresses = append(object.Addresses, model.InventoryAddress{Address: net.ParseIP(strings.TrimSpace(observed)).String(), InterfaceID: v.ID, InterfaceName: v.Name, ManagementOnly: v.ManagementOnly, ObservedOnly: true})
			}
		}
	}
	seenIPs := map[int64]bool{}
	for _, v := range ips {
		if v.ID <= 0 || seenIPs[v.ID] {
			return empty, errors.New("invalid or duplicate NetBox IP")
		}
		seenIPs[v.ID] = true
		if v.AssignedID == nil {
			continue
		}
		a, ok := assignments[fmt.Sprintf("%s:%d", v.AssignedType, *v.AssignedID)]
		if !ok || a.object == nil {
			continue
		}
		address := nbAddress(v.Address)
		if address == "" {
			return empty, errors.New("invalid assigned NetBox IP address")
		}
		entry := model.InventoryAddress{Address: address, DNSName: v.DNSName, InterfaceID: a.iface.ID, InterfaceName: a.iface.Name, ManagementOnly: a.iface.ManagementOnly}
		if v.VRF != nil {
			id := v.VRF.ID
			entry.VRFID = &id
			entry.VRFName = v.VRF.text()
		}
		a.object.Addresses = append(a.object.Addresses, entry)
	}
	now := time.Now().UTC()
	for _, key := range order {
		v := objects[key]
		empty.Candidates = append(empty.Candidates, model.Candidate{IntegrationID: i.ID, ExternalID: key, Name: v.Name, URL: v.NetBoxURL, Labels: map[string]string{"source": "netbox", "object_type": v.Kind}, Inventory: v, State: "pending", LastSeen: now})
	}
	return empty, nil
}
func nbAddress(value string) string {
	if ip, _, e := net.ParseCIDR(value); e == nil {
		return ip.String()
	}
	if ip := net.ParseIP(value); ip != nil {
		return ip.String()
	}
	return ""
}

var netBoxHostLabel = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

func validNetBoxHTTPHost(host string) bool {
	if len(host) > 253 || net.ParseIP(host) != nil {
		return false
	}
	parts := strings.Split(host, ".")
	if len(parts) < 2 {
		return false
	}
	for _, part := range parts {
		if !netBoxHostLabel.MatchString(part) {
			return false
		}
	}
	return true
}
