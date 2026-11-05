"""Render the real standalone/integrated templates and resolve their static files."""
from pathlib import Path
import re
from types import SimpleNamespace
from urllib.parse import urlsplit

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request
from starlette.templating import Jinja2Templates

ROOT = Path(__file__).resolve().parents[1] / 'app'


def render(mode):
    app = FastAPI(root_path='/websites')
    app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
    for name, route in [('home', '/'), ('target_add_get', '/add'), ('history', '/history'),
                        ('rollback_get', '/rollback'), ('logout', '/logout')]:
        async def unused():
            return None
        app.add_api_route(route, unused, name=name)
    request = Request({'type': 'http', 'app': app, 'router': app.router, 'scheme': 'https',
                       'server': ('fixture.example.test', 443), 'root_path': '/websites',
                       'path': '/websites/', 'headers': [], 'query_string': b''})
    templates = Jinja2Templates(directory=ROOT / 'templates')
    return templates.TemplateResponse(request=request, name='base.html', context={
        'request': request, 'title': 'Сайты', 'settings': SimpleNamespace(auth_mode=mode),
        'auth': SimpleNamespace(display_name='Fixture user', user=SimpleNamespace(username='fixture'),
                                identity_source='platform' if mode == 'gateway' else 'local'),
        'csrf_token': 'test-csrf',
    }).body.decode()


def test_real_templates_keep_local_logout_and_use_explicit_asset_owner():
    standalone = render('standalone')
    integrated = render('gateway')
    assert 'Fixture user' in standalone and 'Локальная учётная запись' in standalone
    assert 'Fixture user' in integrated and 'Пользователь Платформы' in integrated
    assert 'action="https://fixture.example.test/websites/logout"' in standalone
    assert 'name="csrf_token" value="test-csrf"' in standalone
    assert 'data-platform-logout' in integrated
    for mode, html in [('standalone', standalone), ('gateway', integrated)]:
        paths = [urlsplit(value).path for value in re.findall(r'(?:src|href)="([^"]+)"', html)]
        assets = [path for path in paths if '/static/' in path or path.startswith('/ecosystem/')]
        assert len(assets) >= 8
        expected = '/ecosystem/ui-v1.js' if mode == 'gateway' else '/websites/static/ecosystem/ui-v1.js'
        assert expected in assets
        for path in assets:
            if path.startswith('/ecosystem/'):
                file = ROOT.parents[1] / 'it-portal/frontend/public' / path.removeprefix('/')
            else:
                file = ROOT / 'static' / path.split('/static/', 1)[1]
            assert file.is_file(), f'{mode}: missing {path}'


def test_real_application_serves_standalone_shared_assets():
    from fastapi.testclient import TestClient
    from app.main import app

    # No lifespan or background jobs: only the real static route is exercised.
    client = TestClient(app, base_url='https://testserver')
    try:
        for name in ('theme-catalog.js', 'theme-runtime.js', 'theme-menu.css', 'ui-v1.js', 'ui-v1.css'):
            response = client.get('/websites/static/ecosystem/' + name)
            assert response.status_code == 200
            assert response.content == (ROOT / 'static/ecosystem' / name).read_bytes()
            assert ('javascript' if name.endswith('.js') else 'text/css') in response.headers['content-type']
        response = client.get('/websites/static/custom-theme.css')
        assert response.status_code == 200
        assert response.content == (ROOT / 'static/custom-theme.css').read_bytes()
    finally:
        client.close()
