package server

import "testing"

func TestSFTPAdminConfigurationIsolation(t *testing.T) {
	keys := []string{"PORTAL_SFTP_ADM_URL", "PORTAL_SFTP_ADM_CA_FILE", "PORTAL_SFTP_ADM_ADMIN_KEY_FILE", "PORTAL_SFTP_ADM_CLIENT_SECRET_FILE", "PORTAL_SFTP_ADM_SIGNING_KEY_FILE"}
	for _, key := range keys {
		t.Setenv(key, "")
	}
	c, e := loadSFTPAdminConfig("https://platform.example.test")
	if e != nil || c != nil {
		t.Fatal("disabled integration must preserve baseline")
	}
	t.Setenv("PORTAL_SFTP_ADM_ALLOWED_CIDRS", "192.0.2.12/32")
	t.Setenv("PORTAL_SFTP_ADM_DATA_ROOT", "/var/lib/sftpgo/data")
	t.Setenv(keys[1], "/certs/files.crt")
	if _, e = loadSFTPAdminConfig("https://platform.example.test"); e == nil {
		t.Fatal("partial configuration accepted")
	}
	for _, key := range keys[1:] {
		t.Setenv(key, "/private/"+key)
	}
	for _, upstream := range []string{"https://192.0.2.12:9443/api/v2", "http://192.0.2.12:9443", "https://198.51.100.12:9443", "https://a@192.0.2.12:9443", "https://192.0.2.12:9443?next=evil"} {
		t.Setenv(keys[0], upstream)
		if _, e = loadSFTPAdminConfig("https://platform.example.test"); e == nil {
			t.Fatalf("unsafe upstream %q accepted", upstream)
		}
	}
	t.Setenv(keys[0], "https://192.0.2.12:9443")
	c, e = loadSFTPAdminConfig("https://platform.example.test")
	if e != nil {
		t.Fatal(e)
	}
	if c.DataRoot != "/var/lib/sftpgo/data" || c.OIDC.RedirectURL != "https://platform.example.test/sftp-adm/web/oidc/redirect" {
		t.Fatal("isolated storage or callback changed")
	}
	if _, e = loadSFTPAdminConfig("http://platform.example.test"); e == nil {
		t.Fatal("insecure issuer origin accepted")
	}
	t.Setenv(keys[2], "relative.key")
	if _, e = loadSFTPAdminConfig("https://platform.example.test"); e == nil {
		t.Fatal("relative credential path accepted")
	}
}
