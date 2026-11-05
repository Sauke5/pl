"""Native NetBox/Gitea sub-path contracts; CI only, no device or daemon IO."""
from email.message import Message
import importlib.util
import io
import json
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'apps/netmap-stack'))
SPEC = importlib.util.spec_from_file_location('pl_gitea_routing_test', ROOT / 'apps/netmap-stack/service.py')
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)


class Reply:
    def __init__(self, status, value):
        self.status, self.value = status, value

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, limit):
        return json.dumps(self.value).encode()


class MemoryHandler:
    def __init__(self, path):
        self.path, self.command = path, 'GET'
        self.headers = Message()
        self.rfile, self.wfile = io.BytesIO(), io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, *args):
        pass

    def end_headers(self):
        pass


class GiteaRouting(unittest.TestCase):
    def test_bootstrap_uses_root_api_and_creates_owned_repository_once(self):
        app = service.Application.__new__(service.Application)
        app.bootstrap_lock, app.bootstrap_ready = threading.Lock(), False
        app.netbox = types.SimpleNamespace(all=Mock(return_value=[{'name': 'collector_ip'}]))
        calls = []
        repository = None

        def open_request(request, timeout):
            nonlocal repository
            url, method = request.full_url, request.get_method()
            calls.append((method, url))
            self.assertEqual(request.get_header('Authorization'), 'token ' + 'a' * 40)
            # The real Gitea listener does not mount ROOT_URL's public prefix.
            if url == 'http://gitea:3000/api/v1/repos/pl-collector/device-configs' and repository:
                return Reply(200, repository)
            if method == 'POST' and url == 'http://gitea:3000/api/v1/user/repos':
                self.assertEqual(json.loads(request.data), {
                    'name': 'device-configs', 'private': True, 'auto_init': False, 'default_branch': 'master'})
                repository = {'private': True, 'owner': {'login': 'pl-collector'}}
                return Reply(201, repository)
            raise service.urllib.error.HTTPError(url, 404, 'not found', {}, io.BytesIO(b'{}'))

        with patch.object(service.Path, 'read_text', return_value='Access token was successfully created... ' + 'a' * 40), \
             patch.object(service.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=open_request)):
            self.assertEqual(app.bootstrap(), {'push_token': 'a' * 40})
            self.assertEqual(app.bootstrap(), {'push_token': 'a' * 40})
        self.assertTrue(app.bootstrap_ready)
        self.assertEqual([method for method, _ in calls], ['GET', 'POST', 'GET'])
        self.assertEqual(app.netbox.all.call_count, 2)

    def test_bootstrap_permission_error_does_not_claim_readiness_or_leak_token(self):
        app = service.Application.__new__(service.Application)
        app.bootstrap_lock, app.bootstrap_ready = threading.Lock(), False
        app.netbox = types.SimpleNamespace(all=Mock())
        token = 'b' * 40
        calls = []

        def open_request(request, timeout):
            calls.append(request.get_method())
            code = 403 if request.get_method() == 'POST' else 404
            raise service.urllib.error.HTTPError(request.full_url, code, token, {}, io.BytesIO(token.encode()))

        with patch.object(service.Path, 'read_text', return_value='Access token was successfully created... ' + token), \
             patch.object(service.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=open_request)):
            with self.assertRaises(ValueError) as error:
                app.bootstrap()
        self.assertEqual(str(error.exception), 'Gitea bootstrap rejected')
        self.assertNotIn(token, str(error.exception))
        self.assertFalse(app.bootstrap_ready)
        self.assertEqual(calls, ['GET', 'POST'])
        app.netbox.all.assert_not_called()

    def test_native_proxy_strips_only_gitea_prefix_and_preserves_query(self):
        app = service.Application.__new__(service.Application)
        app.config = {'hostname': 'pl.example.test'}
        app.verifier = types.SimpleNamespace(verify=Mock(return_value={}))
        handler_type = service.make_handler(app, MemoryHandler)
        for incoming, outgoing in (
                ('/netmap/gitea/', '/'),
                ('/netmap/gitea/user/login?next=repository', '/user/login?next=repository'),
                ('/netmap/netbox/login/', '/netmap/netbox/login/'),
                ('/netmap/oxidized/nodes', '/netmap/oxidized/nodes')):
            response = Mock(status=200)
            response.read.return_value = b'native'
            response.getheaders.return_value = [('Content-Type', 'text/html')]
            connection = Mock()
            connection.getresponse.return_value = response
            with self.subTest(path=incoming), patch.object(service.http.client, 'HTTPConnection', return_value=connection):
                handler = handler_type(incoming)
                handler.dispatch()
                self.assertEqual(handler.status, 200)
                self.assertEqual(connection.request.call_args.args[:2], ('GET', outgoing))
                connection.close.assert_called_once_with()


class NetBoxStaticRouting(unittest.TestCase):
    def setUp(self):
        app = service.Application.__new__(service.Application)
        app.config = {'hostname': 'pl.example.test'}
        app.verifier = types.SimpleNamespace(verify=Mock(return_value={}))
        self.handler_type = service.make_handler(app, MemoryHandler)

    def test_native_messages_cookie_is_forwarded_only_to_netbox(self):
        for path, expected in (
                ('/netmap/netbox/login/', 'messages=signed-native; pl_netbox_sessionid=netbox'),
                ('/netmap/gitea/user/login', 'pl_gitea_session=gitea')):
            response = Mock(status=200)
            response.read.return_value = b'native'
            response.getheaders.return_value = [('Content-Type', 'text/html')]
            connection = Mock()
            connection.getresponse.return_value = response
            with self.subTest(path=path), patch.object(service.http.client, 'HTTPConnection', return_value=connection):
                handler = self.handler_type(path)
                # PL restores the native flash name only after checking its
                # isolated browser name. Neither portal nor other app cookies
                # may reach the native listener.
                handler.headers['Cookie'] = 'portal_session=private; messages=signed-native; pl_netbox_sessionid=netbox; pl_gitea_session=gitea; other=private'
                handler.dispatch()
                self.assertEqual(handler.status, 200)
                self.assertEqual(connection.request.call_args.kwargs['headers']['Cookie'], expected)

    def test_assets_reach_granian_while_django_routes_keep_their_base_path(self):
        for method in ('GET', 'HEAD'):
            for incoming, outgoing in (
                    ('/netmap/netbox/static/netbox.css?v=1', '/static/netbox.css?v=1'),
                    ('/netmap/netbox/static/netbox.js', '/static/netbox.js'),
                    ('/netmap/netbox/static/vendor/font.woff2', '/static/vendor/font.woff2'),
                    ('/netmap/netbox/login/', '/netmap/netbox/login/'),
                    ('/netmap/netbox/api/status/', '/netmap/netbox/api/status/'),
                    ('/netmap/netbox/media/logo.png', '/netmap/netbox/media/logo.png'),
                    ('/netmap/netbox/static-other/file', '/netmap/netbox/static-other/file'),
                    ('/netmap/netbox/static', '/netmap/netbox/static')):
                response = Mock(status=200)
                response.read.return_value = b'asset'
                response.getheaders.return_value = [('Content-Type', 'text/css')]
                connection = Mock()
                connection.getresponse.return_value = response
                with self.subTest(method=method, path=incoming), \
                     patch.object(service.http.client, 'HTTPConnection', return_value=connection) as dial:
                    handler = self.handler_type(incoming)
                    handler.command = method
                    handler.headers['Cookie'] = 'portal_session=platform-private; pl_netbox_sessionid=native'
                    handler.headers['Authorization'] = 'Bearer gateway-private'
                    handler.dispatch()
                    self.assertEqual(handler.status, 200)
                    dial.assert_called_once_with('netbox', 8080, timeout=30)
                    self.assertEqual(connection.request.call_args.args[:2], (method, outgoing))
                    headers = connection.request.call_args.kwargs['headers']
                    self.assertEqual(headers['Cookie'], 'pl_netbox_sessionid=native')
                    self.assertNotIn('Authorization', headers)
                    connection.close.assert_called_once_with()

    def test_static_rewrite_does_not_allow_traversal(self):
        for path in ('/netmap/netbox/static/../private', '/netmap/netbox/static/%2e%2e/private',
                     '/netmap/netbox/static//private', '/netmap/netbox/static/\\private'):
            with self.subTest(path=path), patch.object(service.http.client, 'HTTPConnection') as dial:
                handler = self.handler_type(path)
                handler.dispatch()
                self.assertEqual(handler.status, 400)
                dial.assert_not_called()


if __name__ == '__main__':
    unittest.main()
