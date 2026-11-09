"""Finite ingress routing contract; Nginx syntax/runtime validation belongs to CI."""
from pathlib import Path
import re
import shlex
import unittest

CONFIG = Path(__file__).resolve().parents[1] / 'nginx.conf'


class ModuleProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = CONFIG.read_text()
        cls.locations = []
        # Interpret this installer's flat locations, respecting quoted JSON,
        # regex braces and comment delimiters. Actual Nginx parsing runs in CI.
        header = re.compile(r'location\s+(?:(=|~|\^~)\s+)?(?:"([^"\n]+)"|([^\s{]+))\s*\{')
        for match in header.finditer(cls.config):
            start, depth, quote, escaped, comment = match.end(), 1, '', False, False
            for end in range(start, len(cls.config)):
                char = cls.config[end]
                if comment:
                    if char == '\n':
                        comment = False
                    continue
                if escaped:
                    escaped = False
                    continue
                if char == '\\':
                    escaped = True
                elif quote:
                    if char == quote:
                        quote = ''
                elif char in ('"', "'"):
                    quote = char
                elif char == '#':
                    comment = True
                elif char == '{':
                    depth += 1
                elif char == '}':
                    depth -= 1
                    if depth == 0:
                        break
            else:
                raise ValueError('Unterminated location block')
            lexer = shlex.shlex(cls.config[start:end], posix=True, punctuation_chars=';')
            lexer.whitespace_split = True
            directives, headers, tokens = {}, {}, []
            for token in lexer:
                if token != ';':
                    tokens.append(token)
                    continue
                if tokens:
                    if tokens[0] == 'proxy_set_header':
                        headers[tokens[1]] = tokens[2]
                    else:
                        directives[tokens[0]] = ' '.join(tokens[1:])
                tokens = []
            if tokens:
                raise ValueError('Unterminated location directive')
            cls.locations.append((match.group(1) or 'prefix', match.group(2) or match.group(3), directives, headers))
        cls.default_body_limit = re.search(r'client_max_body_size\s+(\S+);', cls.config).group(1)

    def route(self, uri):
        path = uri.split('?', 1)[0]
        for kind, pattern, directives, headers in self.locations:
            if kind == '=' and path == pattern:
                return directives, headers
        prefixes = [(len(pattern), kind, directives, headers) for kind, pattern, directives, headers in self.locations
                    if kind in ('prefix', '^~') and path.startswith(pattern)]
        self.assertTrue(prefixes, 'No ingress location matches URI')
        _, kind, directives, headers = max(prefixes, key=lambda item: item[0])
        if kind == '^~':
            return directives, headers
        for kind, pattern, regex_directives, regex_headers in self.locations:
            if kind == '~' and re.search(pattern, path):
                return regex_directives, regex_headers
        return directives, headers

    def test_native_roots_and_assets_enter_pl_authentication_gateway(self):
        for prefix in ('audit', 'audit-arch', 'wayline', 'forms', 'doska', 'directory'):
            for suffix in ('', '/', '/assets/app.js', '/api/v1/health'):
                with self.subTest(prefix=prefix, suffix=suffix):
                    directives, headers = self.route('/' + prefix + suffix)
                    self.assertEqual(directives.get('proxy_pass'), 'http://$api')
                    self.assertNotIn('try_files', directives)
                    self.assertEqual(headers.get('Host'), '$http_host')
                    self.assertEqual(headers.get('X-Forwarded-Proto'), 'https')
                    # Session/CSRF remain inputs to PL, never fabricated in Nginx.
                    for protected in ('Cookie', 'Authorization', 'X-CSRF-Token'):
                        self.assertNotIn(protected, headers)
        for path in ('/auditX/', '/audit-archive/', '/doskaX/', '/forms-extra/', '/waylineX/', '/grafanaX/', '/directoryX/'):
            with self.subTest(path=path):
                directives, headers = self.route(path)
                self.assertNotIn('proxy_pass', directives)
                self.assertEqual(directives.get('try_files'), '$uri $uri/ /index.html')

    def test_grafana_uses_native_proxy_for_login_api_plugins_and_websocket(self):
        directives, _ = self.route('/grafana?orgId=2')
        self.assertEqual(directives.get('return'), '308 /grafana/$is_args$args')
        charts, chart_headers = self.route('/grafana/_pl/charts/api/v1/integrations/id/grafana/dashboards')
        self.assertEqual(charts.get('proxy_pass'), 'http://$api$request_uri')
        self.assertNotIn('auth_request', charts)
        self.assertNotIn('Cookie', chart_headers)
        for path in ('/grafana/', '/grafana/login', '/grafana/api/user',
                     '/grafana/api/ds/query?x=1', '/grafana/api/plugins/example/settings',
                     '/grafana/public/plugins/example/module.js', '/grafana/api/live/ws'):
            with self.subTest(path=path):
                directives, headers = self.route(path)
                self.assertEqual(directives.get('proxy_pass'), '$grafana_upstream$request_uri')
                self.assertEqual(directives.get('auth_request'), '/_pl/grafana-upstream')
                self.assertEqual(directives.get('proxy_http_version'), '1.1')
                self.assertEqual(directives.get('client_max_body_size'), '0')
                self.assertEqual(directives.get('proxy_buffering'), 'off')
                self.assertEqual(headers.get('Cookie'), '$grafana_cookie')
                self.assertEqual(headers.get('Authorization'), '$http_authorization')
                self.assertEqual(headers.get('Origin'), '$http_origin')
                self.assertEqual(headers.get('Upgrade'), '$http_upgrade')
                self.assertEqual(headers.get('Connection'), '$grafana_connection')
                for identity in ('X-WEBAUTH-USER', 'X-WEBAUTH-ROLE', 'X-PL-User',
                                 'X-PL-Gateway-Assertion', 'X-PL-Grafana-Cookie'):
                    self.assertEqual(headers.get(identity), '')

    def test_grafana_lookup_is_internal_metadata_without_request_body_or_auth(self):
        directives, headers = self.route('/_pl/grafana-upstream')
        self.assertIn('internal', directives)
        self.assertEqual(directives.get('proxy_pass'), 'http://$api/internal/routing/grafana?')
        self.assertEqual(directives.get('proxy_method'), 'GET')
        self.assertEqual(directives.get('proxy_pass_request_body'), 'off')
        self.assertEqual(directives.get('proxy_pass_request_headers'), 'off')
        self.assertEqual(headers.get('Content-Length'), '')
        self.assertEqual(headers.get('Cookie'), '$http_cookie')
        self.assertNotIn('Authorization', headers)
        self.assertNotIn('auth_request', directives)
        for path in ('/internal/routing/grafana', '/_pl/grafana-upstream/extra'):
            directives, _ = self.route(path)
            self.assertNotIn('proxy_pass', directives)
            self.assertEqual(directives.get('try_files'), '$uri $uri/ /index.html')

    def test_events_and_websocket_have_separate_exact_transport_lanes(self):
        for path in ('/api/v1/stream', '/doska/api/doska/events'):
            directives, headers = self.route(path)
            self.assertEqual(directives.get('proxy_pass'), 'http://$api')
            self.assertEqual(directives.get('proxy_buffering'), 'off')
            self.assertEqual(directives.get('proxy_read_timeout'), '1h')
            self.assertNotIn('Upgrade', headers)
            self.assertEqual(headers.get('Connection'), '')
        for identifier in ('user', 'project_1', 'a' * 128):
            directives, headers = self.route('/doska/api/ws/' + identifier + '?windowId=window_1')
            self.assertEqual(directives.get('proxy_pass'), 'http://$api')
            self.assertEqual(directives.get('proxy_http_version'), '1.1')
            self.assertEqual(headers.get('Upgrade'), '$http_upgrade')
            self.assertEqual(headers.get('Connection'), 'upgrade')
        for path in ('/doska/api/ws/', '/doska/api/ws/project.1', '/doska/api/ws/a/extra',
                     '/doska/api/ws/' + 'a' * 129, '/doska/api/doska/events/extra',
                     '/forms/api/ws/user', '/api/v1/session', '/audit/api/v1/health'):
            with self.subTest(path=path):
                directives, headers = self.route(path)
                self.assertEqual(directives.get('proxy_pass'), 'http://$api')
                self.assertNotIn('Upgrade', headers)
                self.assertEqual(headers.get('Connection'), '')
                self.assertEqual(directives.get('proxy_read_timeout'), '60s')

    def test_wayline_probes_retain_bounded_long_request_timeout(self):
        for path in ('/wayline', '/wayline/', '/wayline/api/v1/targets/1/checks'):
            directives, headers = self.route(path)
            self.assertEqual(directives.get('proxy_pass'), 'http://$api')
            self.assertEqual(directives.get('proxy_read_timeout'), '230s')
            self.assertEqual(directives.get('proxy_send_timeout'), '230s')
            self.assertEqual(directives.get('proxy_buffering'), 'off')
            self.assertNotIn('Upgrade', headers)

    def test_large_body_exceptions_do_not_leak_to_other_api_routes(self):
        self.assertEqual(self.default_body_limit, '5m')
        upload = '/doska/api/doska/projects/project_1/tasks/task-1/attachment-uploads/upload-1/content'
        directives, headers = self.route(upload)
        self.assertEqual(directives.get('client_max_body_size'), '25m')
        self.assertEqual(directives.get('proxy_request_buffering'), 'off')
        self.assertEqual(directives.get('proxy_buffering'), 'off')
        self.assertEqual(directives.get('proxy_pass'), 'http://$api')
        self.assertNotIn('Upgrade', headers)
        sftp = '/api/v1/modules/01234567-89ab-4def-8123-456789abcdef/sftpgo/files/content'
        directives, _ = self.route(sftp)
        self.assertEqual(directives.get('client_max_body_size'), '1g')
        self.assertEqual(directives.get('proxy_request_buffering'), 'off')
        self.assertEqual(directives.get('proxy_send_timeout'), '30m')
        for path in (upload + '/extra', upload.replace('upload-1', 'upload.1'),
                     '/doska/api/doska/projects/p/tasks/t/attachments', '/doska/api/doska/task-search',
                     sftp + '/extra', '/api/v1/modules/abc/sftpgo/users', '/forms/api/v1/forms'):
            with self.subTest(path=path):
                directives, _ = self.route(path)
                self.assertEqual(directives.get('proxy_pass'), 'http://$api')
                self.assertNotIn('client_max_body_size', directives)


    def test_wiki_upload_limit_also_covers_bodyless_internal_authorization(self):
        upload, _ = self.route('/wiki/attachments/upload')
        authorization, headers = self.route('/_pl/bookstack-upstream')
        # Nginx evaluates the subrequest against the original upload length.
        # Admit the same bounded size without forwarding the file to auth.
        self.assertEqual(upload.get('client_max_body_size'), '101m')
        self.assertEqual(authorization.get('client_max_body_size'), upload['client_max_body_size'])
        self.assertIn('internal', authorization)
        self.assertEqual(authorization.get('proxy_method'), 'GET')
        self.assertEqual(authorization.get('proxy_pass_request_body'), 'off')
        self.assertEqual(headers.get('Content-Length'), '')


if __name__ == '__main__':
    unittest.main()
