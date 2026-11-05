"""Inventory transport and owned secret lifecycle, with no remote targets."""
import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

BASE = Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('inventory_controller_test',BASE/'inventory-controller.py')
inventory=importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        for name in ('private','state','modules'):(self.root/name).mkdir(mode=0o700)
        self.id=str(uuid.uuid4());self.installation='pl-inventory-test'
        self.image={'id':'sha256:'+'1'*64,'architecture':'amd64','ref':'pl/core-inventory-server:0.3.0','recipe':'deploy/images/inventory.Dockerfile','labels':{'pl.module.id':'inventory','pl.module.role':'server','pl.module.config.version':'1','pl.build.variant':'source-build','org.opencontainers.image.version':'1.0.0','pl.source.sha256':'a'*64}}
        inventory.atomic(self.root/'state/installation.json',{'install_id':self.installation,'manifest_sha256':'a'*64,'config':{}})
        inventory.atomic(self.root/'private/module-images.json',{'schema':1,'installation':self.installation,'manifest_sha256':'a'*64,'inventory':{'server':self.image}})
        inventory.atomic(self.root/'private/module-controller-key',b'm'*32,mode=0o640)
        self.parent=types.SimpleNamespace(root=self.root,installation=self.installation,docker=lambda *a,**k: self.fail('unexpected Docker operation'))
        for name,value in (('UID',os.geteuid()),('GID',os.getegid())):
            mock=patch.object(inventory,name,value);mock.start();self.addCleanup(mock.stop)
        self.controller=inventory.InventoryController(self.parent)

    def test_private_key_and_import_password_survive_repeated_initialization(self):
        self.controller.initialize(self.id)
        path=self.controller.path(self.id)
        expected=hmac.digest(b'm'*32,('pl-module-key-v1\ninventory\n'+self.id).encode(),'sha256')
        self.assertEqual((path/'config/gateway.key').read_bytes(),expected)
        self.assertEqual((path/'config/gateway.key').stat().st_mode&0o777,0o440)
        self.assertFalse(self.controller.settings({'instance_id':self.id})['archive_password_configured'])
        secret=' password with trailing space '
        result=self.controller.settings({'instance_id':self.id,'operation_id':str(uuid.uuid4()),'archive_password':secret})
        self.assertEqual(result,{'instance_id':self.id,'archive_password_configured':True})
        self.assertNotIn(secret,json.dumps(result))
        self.controller.initialize(self.id)
        self.assertEqual((path/'config/archive-password').read_bytes(),secret.encode())
        self.assertEqual((path/'config/archive-password').stat().st_mode&0o777,0o440)
        self.assertNotIn(secret,(path/'state.json').read_text())

    def test_unsafe_import_password_and_symlink_are_refused_without_overwrite(self):
        self.controller.initialize(self.id)
        for secret in ('','x'*4097,'abc\x00def'):
            with self.assertRaises(ValueError):self.controller.settings({'instance_id':self.id,'operation_id':str(uuid.uuid4()),'archive_password':secret})
        outside=self.root/'outside';outside.write_bytes(b'keep')
        (self.controller.path(self.id)/'config/archive-password').symlink_to(outside)
        with self.assertRaises(ValueError):self.controller.settings({'instance_id':self.id,'operation_id':str(uuid.uuid4()),'archive_password':'new'})
        self.assertEqual(outside.read_bytes(),b'keep')

    def test_foreign_descriptor_and_changed_gateway_key_are_refused(self):
        self.controller.initialize(self.id)
        key=self.controller.path(self.id)/'config/gateway.key';key.chmod(0o600);key.write_bytes(b'f'*32);key.chmod(0o440)
        with self.assertRaisesRegex(ValueError,'key drift'):self.controller.initialize(self.id)
        value=json.loads((self.root/'private/module-images.json').read_text());value['installation']='pl-foreign'
        inventory.atomic(self.root/'private/module-images.json',value)
        with self.assertRaisesRegex(ValueError,'installation identity'):inventory.InventoryController(self.parent)

    def test_routes_and_scopes_do_not_open_arbitrary_endpoints(self):
        for path,query in (('/inventory/',''),('/inventory/static/report.js',''),('/inventory/api/data','page=1'),('/inventory/api/software','search=Office&limit=10')):
            self.assertEqual(inventory.request_scope('GET',path,query,'',b''),'inventory:read')
        self.assertEqual(inventory.request_scope('POST','/inventory/api/imports/preview','','multipart/form-data; boundary=fixture',b'upload','fixture-key'),'inventory:write')
        for args in (('GET','/healthz','','',b''),('GET','/inventory/../secret','','',b''),('GET','/inventory/api/software','page=1&page=2','',b''),('GET','/inventory/api/data','url=http://outside','',b''),('POST','/inventory/api/imports/preview','','application/json',b'{}','key'),('GET','/inventory/api/data','','',b'body'),('POST','/inventory/api/imports/'+self.id+'/commit','','application/json',b'{"extra":true}','key')):
            with self.subTest(args=args),self.assertRaises(ValueError):inventory.request_scope(*args)

    def test_transport_preserves_signed_bytes_and_never_accepts_cookies_or_auth(self):
        self.controller.initialize(self.id)
        self.controller._routes[self.id]=(inventory.time.monotonic(),'http://192.0.2.1:8587')
        calls=[]
        self.controller.http=lambda *args: calls.append(args) or (200,'application/json',b'{"dataset":{}}')
        body={'instance_id':self.id,'method':'GET','path':'/inventory/api/data','query':'page=1','content_type':'','body':'','headers':{'X-PL-Gateway-Assertion':'valid-assertion','X-PL-Gateway-Signature':'valid-signature'}}
        out=self.controller.request(body)
        self.assertEqual(base64.b64decode(out['body']),b'{"dataset":{}}')
        self.assertEqual(calls[0][2],'/inventory/api/data?page=1')
        for name in ('Authorization','Cookie','X-Forwarded-For'):
            changed={**body,'headers':{**body['headers'],name:'injected'}}
            with self.assertRaises(ValueError):self.controller.request(changed)
        self.assertEqual(len(calls),1)


if __name__=='__main__':unittest.main()
