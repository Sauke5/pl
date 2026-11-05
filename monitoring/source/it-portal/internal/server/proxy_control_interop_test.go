//go:build optional_module_acceptance

package server

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestProxyControlPythonVerifierInterop(t *testing.T) {
	oracle := os.Getenv("PORTAL_PROXY_VERIFIER_FILE")
	if oracle == "" {
		t.Fatal("explicit controller verifier path required")
	}
	dir := t.TempDir()
	key := bytes.Repeat([]byte{23}, 32)
	keyPath := filepath.Join(dir, "key")
	if err := os.WriteFile(keyPath, key, 0600); err != nil {
		t.Fatal(err)
	}
	r := proxyRequest("POST", "/api/v1/mode", `{"mode":"relay","expected_revision":0}`, true)
	body, _ := io.ReadAll(r.Body)
	sess := current(r)
	r.Header.Set("X-CSRF-Token", gatewayServiceCSRF(sess.CSRF, "proxy-control"))
	if err := signGatewayRequest(r, body, sess, "proxy-control", []string{"proxy:mode"}, key, time.Now(), true, "10.0.0.9"); err != nil {
		t.Fatal(err)
	}
	packet := map[string]any{"headers": r.Header, "body": string(body)}
	data, _ := json.Marshal(packet)
	script := `import sys,json,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('oracle',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
v=m.GatewayVerifier(Path(sys.argv[2]));v.validate_configuration();p=json.load(sys.stdin)
h=[(k.lower().encode(),item.encode()) for k,items in p['headers'].items() for item in items]
s={'method':'POST','raw_path':b'/api/v1/mode','query_string':b'','headers':h}
c=v.verify(s,p['body'].encode(),required_scope='proxy:mode');assert c['sub']=='fixture-admin'
for label,changed,body in [('replay',s,p['body']),('uri',{**s,'query_string':b'x=1'},p['body']),('body',s,p['body']+' '),('scope',{**s,'method':'GET','raw_path':b'/api/v1/status'},p['body'])]:
 try:v.verify(changed,body.encode(),required_scope='proxy:mode')
 except m.GatewayError:continue
 raise AssertionError(label+' accepted')
print('v1 compatibility, replay and request binding verified')`
	cmd := exec.Command("python3", "-B", "-c", script, oracle, keyPath)
	cmd.Stdin = bytes.NewReader(data)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("oracle failed: %v %s", err, output)
	}
}
