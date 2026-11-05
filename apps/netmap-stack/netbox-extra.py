import json
from pathlib import Path
_c = json.loads(Path('/run/secrets/netbox.json').read_text())
DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql', 'NAME': 'netbox', 'USER': 'netbox', 'HOST': 'database', 'PORT': 5432, 'PASSWORD': _c['database_password'], 'CONN_MAX_AGE': 300}}
SECRET_KEY = _c['secret_key']
API_TOKEN_PEPPERS = {1: _c['token_pepper']}
REDIS = {
    'tasks': {'HOST': 'cache', 'PORT': 6379, 'DATABASE': 0, 'PASSWORD': _c['cache_password'], 'SSL': False},
    'caching': {'HOST': 'cache', 'PORT': 6379, 'DATABASE': 1, 'PASSWORD': _c['cache_password'], 'SSL': False},
}
BASE_PATH = 'netmap/netbox/'
ALLOWED_HOSTS = [_c['hostname'], 'netbox', 'localhost', '127.0.0.1']
CSRF_TRUSTED_ORIGINS = [_c['origin']]
SESSION_COOKIE_PATH = '/netmap/netbox/'
CSRF_COOKIE_PATH = '/netmap/netbox/'
SESSION_COOKIE_NAME = 'pl_netbox_sessionid'
CSRF_COOKIE_NAME = 'pl_netbox_csrftoken'
CENSUS_REPORTING_ENABLED = False
LOGIN_REQUIRED = True
SKIP_SUPERUSER = True
