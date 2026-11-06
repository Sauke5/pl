import copy, json, threading, unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock
import test_netmap_access_profiles as setup
service = setup.service

class Native:

    def __init__(self, network):
        self.etag = 'W/"2026-11-06T00:00:00+00:00"'
        self.patch_calls = []
        self.records = {i: {'id': i, 'name': 'device' + str(i), 'tags': [{'id': 7, 'slug': 'network-config-backup'}, {'id': 9, 'slug': 'manual-tag'}], 'comments': 'manual data', 'custom_fields': {'pl_source': 'network:' + network, 'collector_ip': '192.0.2.' + str(i), 'collector_profile': 'a' if i == 1 else 'b', 'oxidized_model': 'ios', 'pl_observed_description': 'manual'}} for i in (1, 2)}

    def all(self, path, **query):
        if path == '/extras/tags/':
            return [{'id': 7, 'slug': 'network-config-backup'}]
        return [copy.deepcopy(v) for v in self.records.values() if all((v['custom_fields'].get(k.removeprefix('cf_')) == value for k, value in query.items()))]

    def request(self, method, path, body=None, *, version=None, include_version=False):
        i = int(path.rstrip('/').split('/')[-1])
        record = self.records[i]
        if method == 'PATCH':
            if version != self.etag:
                raise service.RequestError('netmap_device_changed')
            self.patch_calls.append(copy.deepcopy(body))
            record['custom_fields'].update(body.get('custom_fields', {}))
            if 7 in body.get('add_tags', []) and not any(tag['id'] == 7 for tag in record['tags']):
                record['tags'].append({'id': 7, 'slug': 'network-config-backup'})
            record['tags'] = [tag for tag in record['tags'] if tag['id'] not in body.get('remove_tags', [])]
            self.etag = 'W/"2026-11-06T00:00:01+00:00"'
        return (copy.deepcopy(record), self.etag) if include_version else copy.deepcopy(record)

class DeviceAccess(unittest.TestCase):
    change = setup.OrderedProfiles.change
    network = setup.OrderedProfiles.network

    def setUp(self):
        setup.OrderedProfiles.setUp(self)
        self.network_id = self.network(snmp_profiles=['a', 'b'])
        for n in ('a', 'b'):
            self.change('/api/profiles', {'id': n, 'username': 'user-' + n, 'password': 'private-' + n, 'oxidized_model': 'ios', 'ssh_known_hosts': '192.0.2.1 ssh-ed25519 ' + 'A' * 44 + '\n192.0.2.2 ssh-ed25519 ' + 'A' * 44})
        self.app.netbox = Native(self.network_id)
        self.app.reload_collector = Mock(return_value={'state': 'ready', 'targets': 2})
        self.app.native_device_records = Mock(return_value={})

    def payload(self, **patch):
        return {'network_id': self.network_id, 'profile_id': 'b', 'model': '', 'collector_ip': '192.0.2.1', 'version': self.app.netbox.etag, **patch}

    def test_selected_device_binding_is_conditional_partial_and_preserves_other_device(self):
        untouched = copy.deepcopy(self.app.netbox.records[2])
        out = self.app.save_device_binding(1, self.payload())
        self.assertTrue(out['saved'])
        self.assertFalse(out['collection_confirmed'])
        self.assertEqual(self.app.netbox.records[2], untouched)
        self.assertEqual(self.app.netbox.patch_calls, [{'custom_fields': {'collector_profile': 'b', 'oxidized_model': ''}, 'add_tags': [7]}])
        self.assertEqual(self.app.netbox.records[1]['custom_fields']['pl_observed_description'], 'manual')

    def test_foreign_source_ip_missing_credentials_and_stale_version_refuse_before_write(self):
        for patch in ({'network_id': 'f' * 16}, {'collector_ip': '192.0.2.2'}, {'profile_id': 'missing'}, {'model': '../shell'}, {'version': 'W/"2020-01-01T00:00:00+00:00"'}):
            with self.subTest(patch=patch), self.assertRaises(service.RequestError):
                self.app.save_device_binding(1, self.payload(**patch))
        self.app.netbox.records[1]['custom_fields']['pl_source'] = 'manual'
        with self.assertRaises(service.RequestError):
            self.app.save_device_binding(1, self.payload())
        self.assertEqual(self.app.netbox.patch_calls, [])

    def test_discovery_preserves_existing_profile_and_model_after_network_default_change(self):
        self.network(profile='b')
        before = copy.deepcopy(self.app.netbox.records[1])
        self.app.enroll(self.app.store.networks()[0], {'ip': '192.0.2.1', 'name': 'observed', 'description': 'new observation'})
        after = self.app.netbox.records[1]
        self.assertEqual(after['custom_fields']['collector_profile'], 'a')
        self.assertEqual(after['custom_fields']['oxidized_model'], 'ios')
        self.assertEqual(after['tags'], before['tags'])
        self.assertEqual(after['comments'], before['comments'])
        self.assertEqual(set(self.app.netbox.patch_calls[0]['custom_fields']), {'pl_observed_name', 'pl_observed_description'})

    def native(self, started, ended, status='success'):
        return {'device-1': {'ip': '192.0.2.1', 'model': 'ios', 'last': {'start': started.isoformat(), 'end': ended.isoformat(), 'status': status}}}

    def saved(self, device, action, revision=None):
        return json.dumps([{'oid': 'a' * 40, 'date': '2026-11-06T00:00:00Z'}]).encode() if action == 'versions' else b'private running configuration\n'

    def test_reload_old_success_and_git_do_not_confirm_new_binding(self):
        self.app.save_device_binding(1, self.payload())
        old = datetime.now(timezone.utc) - timedelta(hours=1)
        self.app.native_device_records.return_value = self.native(old, old)
        self.app.native_device_request = self.saved
        out = self.app.device_details(1)
        self.assertEqual(out['collection']['state'], 'unconfirmed')
        self.assertEqual(out['collection']['saved_configuration']['revision'], 'a' * 40)
        self.assertNotIn('private', json.dumps(out))

    def test_actual_fresh_success_with_nonempty_revision_config_confirms_and_fail_keeps_history(self):
        self.app.save_device_binding(1, self.payload())
        now = datetime.now(timezone.utc)
        state = self.app.store.device_access(1)
        state['confirmed_source_at'] = (now - timedelta(seconds=2)).isoformat()
        self.app.store.set_device_access(1, state)
        self.app.native_device_records.return_value = self.native(now - timedelta(seconds=1), now)
        self.app.native_device_request = self.saved
        out = self.app.device_details(1)
        self.assertEqual(out['collection']['state'], 'collected')
        self.assertEqual(out['collection']['saved_configuration']['bytes'], len(b'private running configuration\n'))
        self.app.native_device_records.return_value = self.native(now - timedelta(seconds=1), now, 'no_connection')
        self.assertEqual(self.app.device_details(1)['collection']['state'], 'failed')
        self.app.native_device_records.return_value = self.native(now + timedelta(days=1), now + timedelta(days=1))
        self.assertNotEqual(self.app.device_details(1)['collection']['state'], 'collected')

    def test_profile_rotation_requires_new_confirmation_and_omitted_secrets_survive(self):
        self.app.save_device_binding(1, self.payload())
        self.change('/api/profiles', {'id': 'b', 'password': 'private-rotated'})
        profile = self.app.store.profile('b')
        self.assertEqual(profile['username'], 'user-b')
        self.assertTrue(profile['ssh_known_hosts'])
        now = datetime.now(timezone.utc)
        self.app.native_device_records.return_value = self.native(now, now)
        self.app.native_device_request = self.saved
        self.assertNotEqual(self.app.device_details(1)['collection']['state'], 'collected')

    def test_duplicate_collection_key_queues_once_and_poll_guard_blocks_binding(self):
        self.app._collector_expected = Mock(return_value={'device-1', 'device-2'})
        self.app.native_device_request = Mock(return_value=b'["ok"]')
        body = {'version': self.app.netbox.etag}
        claims = {'idempotency_key': 'same-explicit-collect', 'sub': 'fixture'}
        a = self.app.mutation('/api/devices/1/collect', body, claims)
        b = self.app.mutation('/api/devices/1/collect', body, claims)
        self.assertEqual(a, b)
        self.app.native_device_request.assert_called_once_with(1, 'queue')
        self.app.poll_lock.acquire()
        try:
            with self.assertRaises(service.RequestError):
                self.change('/api/devices/1/ssh-binding', self.payload())
        finally:
            self.app.poll_lock.release()
        self.assertEqual(self.app.netbox.patch_calls, [])

    def test_wrong_loaded_model_or_empty_git_content_never_confirms_collection(self):
        self.app.save_device_binding(1, self.payload())
        now = datetime.now(timezone.utc)
        state = self.app.store.device_access(1)
        state['confirmed_source_at'] = (now - timedelta(seconds=2)).isoformat()
        self.app.store.set_device_access(1, state)
        native = self.native(now - timedelta(seconds=1), now)
        native['device-1']['model'] = 'procurve'
        self.app.native_device_records.return_value = native
        self.app.native_device_request = self.saved
        self.assertFalse(self.app.device_details(1)['device']['source_loaded'])
        native['device-1']['model'] = 'ios'
        self.app.native_device_request = lambda device, action, revision=None: self.saved(device, action, revision) if action == 'versions' else b''
        self.assertEqual(self.app.device_details(1)['collection']['state'], 'unconfirmed')
        self.assertIsNone(self.app.device_details(1)['collection']['saved_configuration'])

    def test_native_model_class_spellings_confirm_only_the_same_configured_identifier(self):
        # Pinned Oxidized0.37 serializes the Ruby class name, not its lowercase filename.
        for expected, actual in (('ios', 'IOS'), ('vrp', 'VRP'), ('junos', 'JunOS'),
                                 ('enterprise_sonic', 'Enterprise_SONiC'), ('apc_aos', 'Apc_aos'),
                                 ('panos_api', 'PanOS_API'), ('cisco', 'IOS'), ('juniper', 'JunOS')):
            with self.subTest(expected=expected, actual=actual):
                self.change('/api/profiles', {'id': 'b', 'oxidized_model': expected})
                self.app.save_device_binding(1, self.payload())
                now = datetime.now(timezone.utc)
                state = self.app.store.device_access(1)
                state['confirmed_source_at'] = (now - timedelta(seconds=2)).isoformat()
                self.app.store.set_device_access(1, state)
                native = self.native(now - timedelta(seconds=1), now)
                native['device-1']['model'] = actual
                self.app.native_device_records.return_value = native
                self.app.native_device_request = self.saved
                detail = self.app.device_details(1)
                self.assertTrue(detail['device']['source_loaded'])
                self.assertEqual(detail['collection']['state'], 'collected')
                self.assertIsNotNone(detail['collection']['saved_configuration'])

    def test_native_model_mismatch_namespace_punctuation_and_non_ascii_never_confirm(self):
        self.app.save_device_binding(1, self.payload())
        now = datetime.now(timezone.utc)
        state = self.app.store.device_access(1)
        state['confirmed_source_at'] = (now - timedelta(seconds=2)).isoformat()
        self.app.store.set_device_access(1, state)
        self.app.native_device_request = self.saved
        for actual in ('VRP', 'JunOS', 'Oxidized::IOS', 'IOS.', 'IOS ', ' IOS', 'IO-S',
                       'İOS', 'ＩＯＳ', None, 1, {}, 'I' * 65):
            with self.subTest(actual=actual):
                native = self.native(now - timedelta(seconds=1), now)
                native['device-1']['model'] = actual
                self.app.native_device_records.return_value = native
                detail = self.app.device_details(1)
                self.assertFalse(detail['device']['source_loaded'])
                self.assertEqual(detail['collection']['state'], 'unconfirmed')
                self.assertIsNone(detail['collection']['saved_configuration'])
        self.change('/api/profiles', {'id': 'b', 'oxidized_model': 'enterprise_sonic'})
        self.app.save_device_binding(1, self.payload())
        native = self.native(now - timedelta(seconds=1), now)
        native['device-1']['model'] = 'EnterpriseSONiC'
        self.app.native_device_records.return_value = native
        self.assertFalse(self.app.device_details(1)['device']['source_loaded'])

    def test_only_pinned_default_aliases_match_and_old_native_success_is_still_unconfirmed(self):
        self.app.native_device_request = self.saved
        for expected, actual in (('cisco', 'JunOS'), ('cisco', 'Cisco'), ('juniper', 'IOS'),
                                 ('juniper_other', 'JunOS')):
            with self.subTest(expected=expected, actual=actual):
                self.change('/api/profiles', {'id': 'b', 'oxidized_model': expected})
                self.app.save_device_binding(1, self.payload())
                now = datetime.now(timezone.utc)
                native = self.native(now, now)
                native['device-1']['model'] = actual
                self.app.native_device_records.return_value = native
                self.assertFalse(self.app.device_details(1)['device']['source_loaded'])
                self.assertEqual(self.app.device_details(1)['collection']['state'], 'unconfirmed')
        self.change('/api/profiles', {'id': 'b', 'oxidized_model': 'cisco'})
        self.app.save_device_binding(1, self.payload())
        old = datetime.now(timezone.utc) - timedelta(hours=1)
        native = self.native(old, old)
        native['device-1']['model'] = 'IOS'
        self.app.native_device_records.return_value = native
        detail = self.app.device_details(1)
        self.assertTrue(detail['device']['source_loaded'])
        self.assertEqual(detail['collection']['state'], 'unconfirmed')
        self.assertIsNotNone(detail['collection']['saved_configuration'])

    def test_unknown_queue_response_is_explicit_and_same_operation_never_queues_again(self):
        self.app._collector_expected = Mock(return_value={'device-1', 'device-2'})
        self.app.native_device_request = Mock(side_effect=OSError('private-error'))
        claims = {'idempotency_key': 'unknown-outcome', 'sub': 'fixture'}
        body = {'version': self.app.netbox.etag}
        first = self.app.mutation('/api/devices/1/collect', body, claims)
        second = self.app.mutation('/api/devices/1/collect', body, claims)
        self.assertEqual(first, second)
        self.assertEqual(first['state'], 'unconfirmed')
        self.assertEqual(self.app.native_device_request.call_count, 1)
        self.assertNotIn('private', json.dumps(first))

    def test_new_device_inherits_current_default_and_profile_model_without_rebinding_existing(self):
        self.network(profile='b')
        native = self.app.netbox
        created = []
        native.get_or_create = Mock(return_value={'id': 7})
        native.all = Mock(side_effect=lambda path, **query: [{'id': 7}] if path == '/extras/tags/' else [])
        native.request = Mock(side_effect=lambda method, path, body: created.append(body) or {'id': 3})
        self.app.enroll(self.app.store.networks()[0], {'ip': '192.0.2.3', 'name': 'New', 'description': 'Observed'})
        fields = created[0]['custom_fields']
        self.assertEqual(fields['collector_profile'], 'b')
        self.assertEqual(fields['oxidized_model'], '')
        self.assertEqual(self.app.device_binding({'custom_fields': fields})[0]['effective_model'], 'ios')

    def test_disable_removes_only_backup_tag_and_model_inheritance_preserves_explicit_overrides(self):
        self.app.save_device_binding(1, self.payload(profile_id='', model=''))
        record = self.app.netbox.records[1]
        self.assertEqual(record['tags'], [{'id': 9, 'slug': 'manual-tag'}])
        self.assertFalse(self.app.device_binding(record)[0]['ssh_ready'])
        self.change('/api/profiles', {'id': 'b', 'oxidized_model': 'junos'})
        self.assertEqual(self.app.device_binding(self.app.netbox.records[2])[0]['effective_model'], 'ios')
        self.app.netbox.records[2]['custom_fields']['oxidized_model'] = ''
        self.assertEqual(self.app.device_binding(self.app.netbox.records[2])[0]['effective_model'], 'junos')
if __name__ == '__main__':
    unittest.main()

class NetBoxConditionalTransport(unittest.TestCase):
    def setUp(self):
        self.native = service.NetBox({'token_key': 'private-key', 'token': 'private-native-token'})
        self.tag = 'W/"2026-11-06T00:00:00+00:00"'

    def test_conditional_patch_uses_native_if_match_and_returns_actual_new_version(self):
        from unittest.mock import patch
        reply = Mock()
        reply.__enter__ = Mock(return_value=reply)
        reply.__exit__ = Mock(return_value=False)
        reply.read.return_value = b'{"id":1}'
        reply.headers = {'ETag': self.tag}
        self.native.opener = Mock()
        self.native.opener.open.return_value = reply
        value, actual = self.native.request('PATCH', '/dcim/devices/1/', {'custom_fields': {'collector_profile': 'a'}}, version=self.tag, include_version=True)
        request = self.native.opener.open.call_args.args[0]
        self.assertEqual(request.get_header('If-match'), self.tag)
        self.assertEqual(json.loads(request.data), {'custom_fields': {'collector_profile': 'a'}})
        self.assertEqual((value, actual), ({'id': 1}, self.tag))
        reply.headers = {}
        with self.assertRaisesRegex(ValueError, 'conditional writes'):
            self.native.request('GET', '/dcim/devices/1/', include_version=True)

    def test_stale_native_precondition_is_not_retried_or_replaced_by_an_unconditional_patch(self):
        import io
        error = service.urllib.error.HTTPError('http://netbox/', 412, 'private-error', {}, io.BytesIO(b'private-detail'))
        self.native.opener = Mock()
        self.native.opener.open.side_effect = error
        with self.assertRaises(service.RequestError) as result:
            self.native.request('PATCH', '/dcim/devices/1/', {}, version=self.tag)
        self.assertEqual(result.exception.code, 'netmap_device_changed')
        self.assertEqual(self.native.opener.open.call_count, 1)
        self.assertTrue(error.closed)
