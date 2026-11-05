"""Optional installation policy; disposable files and mocked Docker/host calls only."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

import test_maintenance as baseline

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pl_integration_bootstrap', BASE / 'bootstrap.py')
pl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pl)
maintenance = baseline.pl
SCRIPT = BASE / 'install.sh'
INSTALL_SOURCE = SCRIPT.read_text().split("<<'PL_INSTALL_PY'\n", 1)[1].rsplit('\nPL_INSTALL_PY', 1)[0]


class IntegrationConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'private').mkdir(mode=0o700)
        self.key = self.root / 'admin-supplied.key'
        self.key.write_bytes(b'fixture-mailcow-key\n')
        self.key.chmod(0o600)
        self.profile = self.root / 'integration.json'
        self.value = {'schema': 1, 'allowed_cidrs': ['10.90.12.5/32'], 'allowed_ports': [8443],
                      'secrets': {'mailcow-ro.key': str(self.key)}}
        self.policy = {'schema': 1, 'allowed_cidrs': ['10.90.12.5/32'], 'allowed_ports': [8443],
                       'secret_names': ['mailcow-ro.key']}
        self.m = {'features': {}, 'images': {'api': {'id': 'sha256:' + '1' * 64},
                  'web': {'id': 'sha256:' + '2' * 64}, 'db': {'ref': 'postgres:17@sha256:' + '3' * 64}}}
        self.write_profile()

    def write_profile(self, value=None):
        self.profile.write_text(json.dumps(self.value if value is None else value))
        self.profile.chmod(0o600)

    def owned_identity(self, module=pl):
        # No root/chown-to-another-user requirement in contract tests. Production
        # constants remain 10001:10001; here use the disposable files' real owner.
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(module, 'INTEGRATION_UID', os.geteuid()))
        stack.enter_context(patch.object(module, 'INTEGRATION_GID', os.getegid()))
        return stack

    def prepare(self):
        policy, supplied = pl.load_integration_config(self.profile)
        pl.prepare_integration_secrets(self.root, policy, supplied, existing=False)
        return policy, supplied

    def tearDown(self):
        base = self.root / 'private/integration-secrets'
        if base.is_dir() and not base.is_symlink():
            base.chmod(0o700)

    def rejected(self):
        with self.assertRaises(ValueError) as caught:
            pl.load_integration_config(self.profile)
        text = str(caught.exception)
        self.assertNotIn('fixture-mailcow-key', text)
        self.assertNotIn(str(self.key), text)
        self.assertNotIn('private-input', text)

    def test_profile_yields_only_canonical_names_and_explicit_values(self):
        value = copy.deepcopy(self.value)
        value['allowed_cidrs'] += ['2001:db8:12::5/128', '192.0.2.15/32']
        value['allowed_ports'] += [443, 80, 9090]
        self.write_profile(value)
        policy, supplied = pl.load_integration_config(self.profile)
        self.assertEqual(set(supplied), {'mailcow-ro.key'})
        self.assertEqual(supplied['mailcow-ro.key'], b'fixture-mailcow-key\n')
        self.assertEqual(policy['allowed_ports'], [80, 443, 8443, 9090])
        self.assertNotIn(str(self.key), json.dumps(policy))
        self.assertNotIn('fixture-mailcow-key', json.dumps(policy))
        cfg = pl.configuration('https://pl.example', '127.0.0.1', 'admin', '10.91.1.0/24', integration=policy)
        self.assertEqual(cfg['integration_config'], policy)
        self.assertNotIn(str(self.key), json.dumps(cfg))
        self.assertNotIn('fixture-mailcow-key', json.dumps(cfg))

    def test_input_rejects_unknown_duplicate_keys_and_nonfinite_values(self):
        changes = [lambda x: x.update(schema=True), lambda x: x.update(extra='private-input'),
                   lambda x: x.pop('secrets'), lambda x: x.update(allowed_cidrs='10.0.0.0/8'),
                   lambda x: x.update(allowed_ports=[True]), lambda x: x.update(allowed_ports=[0]),
                   lambda x: x.update(allowed_ports=[65536]), lambda x: x.update(allowed_ports=['8443']),
                   lambda x: x.update(allowed_ports=[80, 80]), lambda x: x.update(allowed_ports=list(range(1,66))),
                   lambda x: x.update(allowed_cidrs=['10.90.12.5/32']*2),
                   lambda x: x.update(secrets={'../escape':str(self.key)}),
                   lambda x: x.update(secrets={'file:name':str(self.key)}),
                   lambda x: x.update(secrets={'private-input': 'relative/path'}),
                   lambda x: x.update(secrets={str(i):str(self.key) for i in range(33)})]
        for change in changes:
            value=copy.deepcopy(self.value)
            change(value)
            self.write_profile(value)
            with self.subTest(value=value):
                self.rejected()
        self.profile.write_text('{"schema":1,"schema":1,"allowed_cidrs":[],"allowed_ports":[],"secrets":{}}')
        self.profile.chmod(0o600)
        self.rejected()

    def test_forbidden_networks_and_ranges_containing_them_are_rejected(self):
        for cidr in ('0.0.0.0/0', '0.0.0.0/1', '127.0.0.1/32', '126.0.0.0/7',
                     '169.254.169.254/32', '100.100.100.0/24', '168.63.129.16/32', '224.0.0.0/4',
                     '::/0', '::1/128', 'fe80::/64', 'ff00::/8', 'fd00:ec2::254/128',
                     '::ffff:10.90.12.5/128', '10.90.12.5/24', '10.90.12.5'):
            value=copy.deepcopy(self.value)
            value['allowed_cidrs']=[cidr]
            self.write_profile(value)
            with self.subTest(cidr=cidr):
                self.rejected()

    def test_private_regular_nofollow_and_size_bounds_apply_to_profile_and_keys(self):
        for mode in (0o644,0o400,0o660):
            self.profile.chmod(mode)
            self.rejected()
        self.write_profile()
        original=self.profile.read_bytes()
        self.profile.unlink()
        self.profile.symlink_to(self.key)
        self.rejected()
        self.profile.unlink()
        self.write_profile()
        linked=self.root/'linked-parent'
        linked.symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(ValueError):
            pl.load_integration_config(linked/'integration.json')
        original_fstat=pl.os.fstat
        def foreign_owner(fd):
            fields=list(original_fstat(fd))
            fields[4]=os.geteuid()+100000
            return os.stat_result(fields)
        with patch.object(pl.os,'fstat',side_effect=foreign_owner):
            self.rejected()
        self.profile.write_bytes(b' '*(pl.INTEGRATION_PROFILE_LIMIT+1))
        self.rejected()
        self.profile.write_bytes(original)
        for contents,mode in ((b'fixture-mailcow-key',0o644),(b'',0o600),
                              (b'x'*(pl.INTEGRATION_SECRET_LIMIT+1),0o600),(b'first\nsecond',0o600)):
            self.key.write_bytes(contents)
            self.key.chmod(mode)
            self.rejected()
        self.key.unlink()
        self.key.symlink_to(self.profile)
        self.rejected()
        self.key.unlink()
        os.mkfifo(self.key,0o600)
        self.rejected()  # Must fail from fstat without blocking on a FIFO reader.

    def test_owned_copy_permissions_repeat_and_missing_changed_fail_without_rotation(self):
        self.assertEqual((pl.INTEGRATION_UID,pl.INTEGRATION_GID),(10001,10001))
        with self.owned_identity(), patch.object(pl.os,'chown',wraps=os.chown) as chown:
            policy,supplied=self.prepare()
            base=self.root/'private/integration-secrets'
            owned=base/'mailcow-ro.key'
            self.assertEqual(stat.S_IMODE(base.stat().st_mode),0o500)
            self.assertEqual(stat.S_IMODE(owned.stat().st_mode),0o400)
            self.assertEqual(owned.read_bytes(),supplied['mailcow-ro.key'])
            self.assertEqual(len(chown.call_args_list),2)
            self.assertTrue(all(call.args[1:]==(os.geteuid(),os.getegid()) for call in chown.call_args_list))
            before=(owned.stat().st_ino,owned.stat().st_mtime_ns,owned.read_bytes())
            chown.reset_mock()
            pl.prepare_integration_secrets(self.root,policy,supplied,existing=True)
            self.assertEqual(before,(owned.stat().st_ino,owned.stat().st_mtime_ns,owned.read_bytes()))
            chown.assert_not_called()
            with self.assertRaisesRegex(ValueError,'never rotate'):
                pl.prepare_integration_secrets(self.root,policy,{'mailcow-ro.key':b'changed-key'},existing=True)
            self.assertEqual(owned.read_bytes(),before[2])
            owned.chmod(0o600)
            owned.write_bytes(b'changed-owned-key')
            owned.chmod(0o400)
            with self.assertRaisesRegex(ValueError,'never rotate'):
                pl.prepare_integration_secrets(self.root,policy,supplied,existing=True)
            self.assertEqual(owned.read_bytes(),b'changed-owned-key')
            base.chmod(0o700)
            owned.unlink()
            base.chmod(0o500)
            with self.assertRaisesRegex(ValueError,'missing or differ'):
                pl.prepare_integration_secrets(self.root,policy,supplied,existing=True)
            self.assertFalse(owned.exists())

    def test_opaque_32_byte_gateway_key_survives_load_copy_validate_and_repeat(self):
        for text in (b'fixture-mailcow-key',b'fixture-mailcow-key\n'):
            self.key.write_bytes(text)
            policy,supplied=pl.load_integration_config(self.profile)
            self.assertEqual(supplied['mailcow-ro.key'],text)
        raw=b'\x00\xff\n'+bytes(range(29))
        self.assertEqual(len(raw),32)
        self.key.write_bytes(raw)
        self.key.chmod(0o600)
        with self.owned_identity():
            policy,supplied=self.prepare()
            self.assertEqual(supplied['mailcow-ro.key'],raw)
            self.assertEqual(pl.validate_integration_secrets(self.root,policy)['mailcow-ro.key'],raw)
            owned=self.root/'private/integration-secrets/mailcow-ro.key'
            before=(owned.stat().st_ino,owned.stat().st_mtime_ns,owned.read_bytes())
            self.assertEqual(stat.S_IMODE(owned.stat().st_mode),0o400)
            pl.prepare_integration_secrets(self.root,policy,supplied,existing=True)
            self.assertEqual(before,(owned.stat().st_ino,owned.stat().st_mtime_ns,owned.read_bytes()))
            self.assertEqual(owned.read_bytes(),raw)

    def test_existing_owned_directory_symlink_extra_file_and_mode_drift_fail(self):
        with self.owned_identity():
            policy,supplied=self.prepare()
            base=self.root/'private/integration-secrets'
            base.chmod(0o700)
            with self.assertRaises(ValueError):
                pl.prepare_integration_secrets(self.root,policy,supplied,existing=True)
            (base/'unexpected').write_text('preserve')
            base.chmod(0o500)
            with self.assertRaises(ValueError):
                pl.validate_integration_secrets(self.root,policy)
            base.chmod(0o700)
            (base/'unexpected').unlink()
            (base/'mailcow-ro.key').unlink()
            (base/'mailcow-ro.key').symlink_to(self.key)
            base.chmod(0o500)
            with self.assertRaises(ValueError):
                pl.validate_integration_secrets(self.root,policy)

    def test_optional_compose_gives_only_api_exact_refs_mount_and_separate_policy(self):
        cfg=pl.configuration('https://pl.example','127.0.0.1','admin','10.91.1.0/24',integration=self.policy)
        model=pl.compose_model(self.root,self.m,cfg,'pl-123456abcdef')
        api=model['services']['api']
        env=api['environment']
        self.assertEqual(env['PORTAL_ALLOWED_CIDRS'],'127.0.0.1/32,10.90.12.5/32')
        self.assertEqual(env['PORTAL_ALLOWED_PORTS'],'80,443,8443')
        self.assertEqual(env['PORTAL_SECRET_REFS'],'file:mailcow-ro.key')
        self.assertEqual(env['PORTAL_SECRETS_DIR'],'/run/secrets/portal')
        self.assertEqual(env['PORTAL_CHECK_INHERIT_INTEGRATION_POLICY'],'false')
        self.assertEqual(env['PORTAL_CHECK_ALLOWED_CIDRS'],'127.0.0.1/32')
        self.assertEqual(env['PORTAL_CHECK_ALLOWED_PORTS'],'80,443')
        self.assertEqual(env['PORTAL_CHECK_PUBLIC_WEB'],'false')
        binds=[x for x in api['volumes'] if isinstance(x,dict)]
        self.assertEqual(binds,[{'type':'bind','source':str(self.root/'private/integration-secrets'),
            'target':'/run/secrets/portal','read_only':True,'bind':{'create_host_path':False}}])
        self.assertEqual(api['networks'],['backend','egress'])
        self.assertEqual(model['networks']['egress']['ipam']['config'][0]['subnet'],'10.91.1.128/26')
        self.assertTrue(model['networks']['backend']['internal'])
        self.assertNotIn('ports',api)
        for name in ('db','web'):
            self.assertNotIn('/run/secrets/portal',json.dumps(model['services'][name]))
        self.assertNotIn(str(self.key),json.dumps(model))
        self.assertNotIn('fixture-mailcow-key',json.dumps(model))
        with self.assertRaisesRegex(ValueError,'network-cidr'):
            pl.configuration('https://pl.example','127.0.0.1','admin',integration=self.policy)

    def test_legacy_compose_unchanged_and_controller_bind_is_preserved(self):
        cfg=pl.configuration('https://pl.example','127.0.0.1','admin')
        model=pl.compose_model(self.root,self.m,cfg,'pl-123456abcdef')
        env=model['services']['api']['environment']
        self.assertEqual(env['PORTAL_ALLOWED_CIDRS'],'127.0.0.1/32')
        self.assertEqual(env['PORTAL_ALLOWED_PORTS'],'80,443')
        self.assertNotIn('PORTAL_SECRET_REFS',env)
        self.assertEqual(model['services']['api']['networks'],['backend'])
        self.assertNotIn('integration_config',cfg)
        self.m['features']['module_controller']=True
        (self.root/'.pl-installation.json').write_text(json.dumps({'gid':997}))
        cfg=pl.configuration('https://pl.example','127.0.0.1','admin','10.91.1.0/24',integration=self.policy)
        model=pl.compose_model(self.root,self.m,cfg,'pl-123456abcdef')
        binds=[x for x in model['services']['api']['volumes'] if isinstance(x,dict)]
        self.assertEqual({x['target'] for x in binds},{'/run/pl-module-controller','/run/secrets/module-controller-key','/run/secrets/portal'})
        self.assertTrue(all(x['read_only'] and not x['bind']['create_host_path'] for x in binds))
        self.assertEqual(model['services']['api']['group_add'],['997'])

    def test_wrapper_validates_verified_profile_before_host_preparation_and_forwards_it(self):
        wrapper=types.ModuleType('pl_install_integration_test')
        exec(compile(INSTALL_SOURCE,str(SCRIPT),'exec'),wrapper.__dict__)
        archive=self.root/'verified-package.tar'
        source=(BASE/'bootstrap.py').read_bytes()
        with tarfile.open(archive,'w') as package:
            member=tarfile.TarInfo('bootstrap.py');member.size=len(source)
            package.addfile(member,io.BytesIO(source))
        wrapper.integration_preflight(archive,self.profile)
        self.profile.chmod(0o644)
        with self.assertRaises(wrapper.InstallError):
            wrapper.integration_preflight(archive,self.profile)
        with patch.object(wrapper,'preflight') as preflight:
            with self.assertRaisesRegex(wrapper.InstallError,'network-cidr'):
                wrapper.main(['--integration-config',str(self.profile),'--check'])
            preflight.assert_not_called()
        self.profile.chmod(0o600)
        info={'distribution':'ubuntu','codename':'noble','architecture':'amd64'}
        release=self.root/'release'
        argv=['--root',str(self.root/'new-root'),'--package',str(archive),'--public-url','https://pl.example',
              '--self-signed','--network-cidr','10.91.1.0/24','--integration-config',str(self.profile)]
        with patch.object(wrapper,'preflight',return_value=info), patch.object(wrapper,'verify_package',return_value={}), \
                patch.object(wrapper,'prepare_root') as prepare, patch.object(wrapper,'stage_release',return_value=release), \
                patch.object(wrapper,'install_docker'), patch.object(wrapper,'ensure_openssl'), \
                patch.object(wrapper,'run') as run, contextlib.redirect_stdout(io.StringIO()):
            wrapper.main(argv)
            prepare.assert_called_once()
            command=run.call_args.args[0]
            index=command.index('--integration-config')
            self.assertEqual(command[index+1],str(self.profile))
            self.assertNotIn('fixture-mailcow-key',' '.join(command))
        self.profile.chmod(0o644)
        with patch.object(wrapper,'preflight',return_value=info), patch.object(wrapper,'verify_package',return_value={}), \
                patch.object(wrapper,'prepare_root') as prepare, patch.object(wrapper,'install_docker') as docker, \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(wrapper.InstallError):
                wrapper.main(argv)
            prepare.assert_not_called()
            docker.assert_not_called()

    def test_backup_excludes_integration_keys_and_restore_requires_reprovision_before_quiesce(self):
        rt=baseline.FakeRuntime(self.root)
        rt.state['config']['integration_config']=self.policy
        private=rt.private/'integration-secrets'
        private.mkdir(mode=0o700)
        (private/'mailcow-ro.key').write_text('fixture-mailcow-key')
        backup=self.root/'backup.tar'
        with contextlib.redirect_stdout(io.StringIO()) as output:
            maintenance.backup(rt,backup)
        self.assertIn('excluded',output.getvalue())
        with tarfile.open(backup) as package:
            self.assertEqual(set(package.getnames()),{'metadata.json','auth.json','database.dump'})
            self.assertNotIn(b'fixture-mailcow-key',package.extractfile('metadata.json').read())
        rt.calls.clear()
        rt.state['config'].pop('integration_config')
        with self.assertRaisesRegex(ValueError,'Перед восстановлением подготовьте серверные ключи'):
            maintenance.restore(rt,backup,maintenance.bootstrap.digest(backup))
        self.assertFalse(any(call[0] in ('compose','restore_dump','auth') for call in rt.calls))
        rt.state['config']['integration_config']=self.policy
        private.chmod(0o755) # Declared names alone are insufficient: private owned readable files are required.
        with self.assertRaisesRegex(ValueError,'Перед восстановлением подготовьте серверные ключи'):
            maintenance.restore(rt,backup,maintenance.bootstrap.digest(backup))
        self.assertFalse(any(call[0] in ('compose','restore_dump','auth') for call in rt.calls))

    def test_maintenance_admits_only_declared_exact_readonly_bind_and_environment(self):
        factory=baseline.TransferSpoolRuntimeTests()
        def runtime():
            rt,mounts,_,_=factory.fixture(enabled=False)
            rt.state={'config':{'integration_config':copy.deepcopy(self.policy)}}
            mounts['api'].append({'Type':'bind','Source':str(rt.private/'integration-secrets'),'Destination':'/run/secrets/portal','RW':False})
            original=rt.docker
            env=maintenance.bootstrap.integration_environment(self.policy)
            def docker(*args):
                data=original(*args)
                if args==('container','inspect','api'):
                    value=json.loads(data)
                    value[0]['Config']['Env']=[key+'='+item for key,item in env.items()]
                    return json.dumps(value).encode()
                return data
            rt.docker=docker
            return rt,mounts,env
        with patch.object(maintenance.bootstrap,'validate_integration_secrets',return_value={}) as owned:
            rt,mounts,env=runtime()
            rt.validate_runtime()
            owned.assert_called_once()
            for mutation in (lambda m:m[-1].update(RW=True),lambda m:m[-1].update(Source='/foreign'),
                             lambda m:m.append(copy.deepcopy(m[-1])),lambda m:m.pop()):
                rt,mounts,env=runtime();mutation(mounts['api'])
                with self.assertRaises(ValueError):rt.validate_runtime()
            rt,mounts,env=runtime();env['PORTAL_ALLOWED_PORTS']='1,65535'
            with self.assertRaisesRegex(ValueError,'environment'):rt.validate_runtime()
            rt,mounts,env=runtime();rt.state={'config':{}}
            with self.assertRaises(ValueError):rt.validate_runtime()

    def test_explicit_egress_repeat_preflight_without_module_controller_keeps_overlap_guard(self):
        cfg=pl.configuration('https://pl.example','127.0.0.1','admin','10.91.1.0/24',integration=self.policy)
        identity='a'*64
        installation='pl-123456abcdef'
        obj={'Id':identity,'Name':installation+'_egress','Driver':'bridge','Scope':'local','Ingress':False,'Internal':False,
             'Labels':{'pl.installation':installation,'com.docker.compose.project':installation,'com.docker.compose.network':'egress'},
             'IPAM':{'Driver':'default','Config':[{'Subnet':'10.91.1.128/26','Gateway':'10.91.1.129'}]}}
        route={'dst':'10.91.1.128/26','dev':'br-'+identity[:12],'protocol':'kernel','scope':'link','prefsrc':'10.91.1.129'}
        def read(args,**kwargs):
            if args[3:5]==['network','ls']: body=identity+'\n'
            elif args[3:5]==['network','inspect']: body=json.dumps([obj])
            elif args[0]=='ip': body=json.dumps([route])
            else: self.fail('Unexpected host operation')
            return types.SimpleNamespace(returncode=0,stdout=body.encode())
        rt=pl.Runtime(self.root,self.root,self.m)
        with patch.object(pl.subprocess,'run',side_effect=read):
            rt.network_preflight(cfg,installation)
            obj['IPAM']['Config'][0]['Gateway']='10.91.1.130'
            with self.assertRaisesRegex(ValueError,'ownership or subnet'):
                rt.network_preflight(cfg,installation)
