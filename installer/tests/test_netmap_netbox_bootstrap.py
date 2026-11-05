"""Native bootstrap contracts against the NetBox 4.7 User/Token field boundary.

No Django installation, native command, database or credentials are used here.
CI additionally verifies the same bootstrap against real pinned NetBox.
"""
from contextlib import nullcontext
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'apps/netmap-stack/netbox-bootstrap.py'
SOURCE = SCRIPT.read_text()
CONFIG = {'admin_password': 'fixture-admin', 'token_key': 'fixture-key', 'token': 'fixture-token'}


class User:
    def __init__(self, username, pk, is_superuser=True, is_active=True, password=None):
        self.username, self.pk = username, pk
        self.is_superuser, self.is_active, self.password = is_superuser, is_active, password
        self.password_changes, self.unusable_changes, self.saves = 0, 0, 0

    def set_password(self, value):
        self.password = value
        self.password_changes += 1

    def set_unusable_password(self):
        self.password = None
        self.unusable_changes += 1

    def has_usable_password(self):
        return self.password is not None

    def save(self):
        self.saves += 1


class UserManager:
    def __init__(self):
        self.items, self.defaults = {}, []

    def get_or_create(self, username, defaults):
        # Pinned NetBox User supports these fields, not Django's is_staff.
        if set(defaults) - {'is_superuser', 'is_active'}:
            raise ValueError('Unknown NetBox User field')
        self.defaults.append(defaults)
        if username in self.items:
            return self.items[username], False
        value = User(username, len(self.items) + 1, **defaults)
        self.items[username] = value
        return value, True


class TokenManager:
    def __init__(self):
        self.item, self.calls = None, 0

    def get_or_create(self, key, defaults):
        self.calls += 1
        if self.item is not None:
            return self.item, False
        self.item = types.SimpleNamespace(key=key, user_id=defaults['user'].pk,
            version=defaults['version'], write_enabled=defaults['write_enabled'], is_active=True,
            validate=lambda raw: raw == defaults['token'])
        return self.item, True


class FieldManager:
    def __init__(self):
        self.items = {}

    def get_or_create(self, name=None, slug=None, defaults=None):
        key = name or slug
        if key in self.items:
            return self.items[key], False
        types_seen = set()
        value = types.SimpleNamespace(type=(defaults or {}).get('type'),
            object_types=types.SimpleNamespace(add=types_seen.add), types_seen=types_seen)
        self.items[key] = value
        return value, True


class NetBoxBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.users, self.tokens, self.fields = UserManager(), TokenManager(), FieldManager()
        user_module = types.ModuleType('users.models')
        user_module.User = types.SimpleNamespace(objects=self.users)
        user_module.Token = types.SimpleNamespace(objects=self.tokens)
        field_module = types.ModuleType('extras.models')
        field_module.CustomField = types.SimpleNamespace(objects=self.fields)
        field_module.Tag = types.SimpleNamespace(objects=FieldManager())
        content_module = types.ModuleType('django.contrib.contenttypes.models')
        content_module.ContentType = types.SimpleNamespace(objects=types.SimpleNamespace(get=lambda **value: (value['app_label'], value['model'])))
        database_module = types.ModuleType('django.db')
        database_module.transaction = types.SimpleNamespace(atomic=nullcontext)
        names = ('django', 'django.contrib', 'django.contrib.contenttypes', 'users', 'extras')
        self.modules = {name: types.ModuleType(name) for name in names}
        self.modules.update({'users.models': user_module, 'extras.models': field_module,
            'django.contrib.contenttypes.models': content_module, 'django.db': database_module})

    def bootstrap(self, config=None):
        with patch.dict(sys.modules, self.modules), patch.object(Path, 'read_text', return_value=json.dumps(config or CONFIG)):
            exec(compile(SOURCE, str(SCRIPT), 'exec'), {'__name__': 'pl_netbox_bootstrap_test'})

    def test_initial_native_accounts_use_real_fields_and_service_cannot_login(self):
        self.bootstrap()
        admin, service = self.users.items['pl-admin'], self.users.items['pl-netmap']
        self.assertTrue(admin.is_superuser and admin.is_active)
        self.assertEqual(admin.password_changes, 1)
        self.assertEqual(admin.password, CONFIG['admin_password'])
        self.assertTrue(service.is_superuser and service.is_active)
        self.assertFalse(service.has_usable_password())
        self.assertEqual(service.unusable_changes, 1)
        self.assertEqual(self.tokens.item.user_id, service.pk)
        self.assertEqual(self.tokens.item.version, 2)
        self.assertTrue(self.tokens.item.write_enabled)
        self.assertEqual(self.fields.items['pl_source'].types_seen, {('dcim', 'device'), ('dcim', 'interface')})

    def test_repeat_bootstrap_preserves_manually_changed_human_password_and_roles(self):
        self.bootstrap()
        admin, service = self.users.items['pl-admin'], self.users.items['pl-netmap']
        admin.password, admin.is_active, admin.is_superuser = 'manually-changed', False, False
        self.bootstrap({**CONFIG, 'admin_password': 'new-unused-default'})
        self.assertEqual(admin.password, 'manually-changed')
        self.assertFalse(admin.is_active or admin.is_superuser)
        self.assertEqual(admin.password_changes, 1)
        self.assertEqual(service.unusable_changes, 1)

    def test_existing_interactive_disabled_or_underprivileged_service_is_not_adopted(self):
        for changes in ({'password': 'interactive'}, {'is_active': False}, {'is_superuser': False}):
            with self.subTest(changes=changes):
                self.setUp()
                service = User('pl-netmap', 37, **changes)
                self.users.items['pl-netmap'] = service
                with self.assertRaisesRegex(RuntimeError, 'service account identity conflict'):
                    self.bootstrap()
                self.assertEqual(self.tokens.calls, 0)
                self.assertEqual(service.unusable_changes, 0)

    def test_foreign_invalid_or_revoked_api_token_is_not_rotated_or_reenabled(self):
        for changes in ({'user_id': 77}, {'version': 1}, {'validate': lambda raw: False}, {'is_active': False}, {'write_enabled': False}):
            with self.subTest(changes=changes):
                self.setUp()
                self.bootstrap()
                for key, value in changes.items():
                    setattr(self.tokens.item, key, value)
                with self.assertRaisesRegex(RuntimeError, 'API token identity conflict'):
                    self.bootstrap()
                for key, value in changes.items():
                    self.assertEqual(getattr(self.tokens.item, key), value)


if __name__ == '__main__':
    unittest.main()
