import csv
import hashlib
import io
import json
import tempfile
import unittest
import uuid
import warnings
import zipfile
from pathlib import Path
from unittest.mock import patch
from xml.sax.saxutils import escape

import pyzipper
from inventory_service.importer import Importer, ImportValidationError, TABLES, ArchivePasswordConfigurationError, archive_password_from_file

TEST_ARCHIVE_PASSWORD = b"synthetic-inventory-test-password"

CAMPAIGN='11111111-2222-4333-8444-555555555555'
TIME='2026-10-27T10:00:00Z'
CANONICAL='ad:'+CAMPAIGN


def sheet(rows):
    result=['<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>']
    for number,columns in rows.items():
        result.append(f'<row r="{number}">')
        for column,value in columns.items():
            result.append(f'<c r="{column}{number}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>')
        result.append('</row>')
    result.append('</sheetData></worksheet>')
    return ''.join(result)


def make_pair(root,*,campaign=CAMPAIGN,archive_campaign=None,branch='Филиал',answer='Лицензии нет',password=TEST_ARCHIVE_PASSWORD,extra_entries=(),corrupt_hash=False,unknown_canonical=False,duplicate_question=False):
    root=Path(root)
    root.mkdir(parents=True,exist_ok=True)
    xlsx=root/'input.xlsx'
    archive=root/'input.zip'
    qid=hashlib.sha256(b'question').hexdigest()
    question={'QuestionId':qid,'Branch':branch,'ComputerName':'PC','CanonicalId':CANONICAL,'Product':'КриптоПро CSP','Key':'PrioritySoftware.cryptopro.csp.example','Question':'Укажите лицензию'}
    metadata={'SchemaVersion':'1.0','CampaignId':archive_campaign or campaign,'Branch':branch,'CreatedAtUtc':TIME}
    summary={**metadata,'GeneratedAtUtc':TIME,'AdSnapshotCapturedAtUtc':TIME}
    coverage={'CanonicalId':CANONICAL,'Branch':branch,'ComputerName':'PC','Scope':'Eligible','Status':'Success','Expected':'True','Domain':'example.local','Reason':'ok'}
    machine={k:'' for k in TABLES['machines.csv']}
    machine.update(CanonicalId=CANONICAL,Branch=branch,ComputerName='PC',WindowsCaption='Windows 11 Pro',WindowsVersion='10.0',WindowsActivation='Activated',WindowsChannel='OEM:DM',CollectedAtUtc=TIME,WindowsPartialKey='SECRET-PARTIAL-012')
    software={k:'' for k in TABLES['software.csv']}
    software.update(CanonicalId='ad:foreign' if unknown_canonical else CANONICAL,Branch=branch,ComputerName='PC',Name='КриптоПро CSP',Version='5.0',Publisher='Компания КриптоПро',Scope='Machine',Architecture='x64')
    tables={name:[] for name in TABLES}
    tables['questions.csv']=[question,question] if duplicate_question else [question]
    tables['coverage.csv']=[coverage]
    tables['machines.csv']=[machine]
    tables['software.csv']=[software]
    content={'source/campaign.json':json.dumps(metadata).encode(),'data/summary.json':json.dumps(summary).encode()}
    for name,rows in tables.items():
        stream=io.StringIO()
        columns=list(dict.fromkeys([*TABLES[name],*(k for r in rows for k in r)]))
        writer=csv.DictWriter(stream,fieldnames=columns,delimiter=';')
        writer.writeheader();writer.writerows(rows)
        content['data/'+name]=stream.getvalue().encode('utf-8-sig')
    manifest={**metadata,'Files':[{'Path':name,'SHA256':'0'*64 if corrupt_hash and name=='data/software.csv' else hashlib.sha256(value).hexdigest(),'SizeBytes':len(value)} for name,value in content.items()]}
    content['manifest.json']=json.dumps(manifest).encode()
    with pyzipper.AESZipFile(archive,'w',compression=pyzipper.ZIP_DEFLATED,encryption=pyzipper.WZ_AES) as z:
        z.setpassword(password);z.setencryption(pyzipper.WZ_AES,nbits=256)
        for name,value in content.items(): z.writestr(name,value)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',UserWarning)
            for name,value in extra_entries: z.writestr(name,value)
    summary_rows={5:{'A':'Филиал','B':branch},6:{'A':'Сформировано (UTC)','B':TIME},7:{'A':'CampaignId','B':campaign}}
    question_rows={5:{'A':branch,'B':'PC','C':question['Product'],'D':question['Question'],'E':answer,'F':'','G':'Нужно уточнить','H':qid,'I':CANONICAL,'J':question['Key']}}
    coverage_rows={5:{'A':'PC','B':'example.local','C':'AD: опрашиваем','D':'Базовые данные собраны','I':CANONICAL}}
    with zipfile.ZipFile(xlsx,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+''.join(f'<sheet name="{name}" sheetId="{n}" r:id="r{n}"/>' for n,name in enumerate(['Сводка','Вопросы','Охват'],1))+'</sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join(f'<Relationship Id="r{n}" Target="worksheets/sheet{n}.xml"/>' for n in range(1,4))+'</Relationships>')
        for n,rows in enumerate([summary_rows,question_rows,coverage_rows],1): z.writestr(f'xl/worksheets/sheet{n}.xml',sheet(rows))
    return xlsx,archive


class ImporterTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)

    def parse(self,**kwargs):
        return Importer.parse(*make_pair(self.root,**kwargs), archive_password=TEST_ARCHIVE_PASSWORD)

    def test_valid_pair_preserves_answers_and_removes_keys(self):
        result=self.parse()
        self.assertEqual(result['metadata']['campaign_id'],CAMPAIGN)
        self.assertEqual(result['dataset']['questions'][0]['answer'],'Лицензии нет')
        self.assertEqual(result['dataset']['questions'][0]['evidence'],'missing')
        self.assertEqual(result['dataset']['summary']['directMissing'],1)
        self.assertEqual(len(result['dataset']['software']),1)
        self.assertNotIn('SECRET-PARTIAL-012',json.dumps(result))
        self.assertNotIn('WindowsPartialKey',json.dumps(result))

    def test_pair_identity_is_not_based_on_filename(self):
        x,z=make_pair(self.root)
        x2=self.root/'random.xlsx';z2=self.root/'random.zip'
        x.rename(x2);z.rename(z2)
        result=Importer.parse(x2,z2,xlsx_name='report.xlsx',archive_name='report.zip',archive_password=TEST_ARCHIVE_PASSWORD)
        self.assertEqual(result['dataset']['sources'][0]['name'],'report.xlsx')

    def test_wrong_campaign_rejected(self):
        with self.assertRaisesRegex(ImportValidationError,'разным кампаниям'):
            self.parse(archive_campaign=str(uuid.uuid4()))

    def test_wrong_password_rejected(self):
        with self.assertRaises(ImportValidationError): self.parse(password=b'incorrect')

    def test_manifest_tampering_rejected(self):
        with self.assertRaises(ImportValidationError) as error:self.parse(corrupt_hash=True)
        self.assertEqual(error.exception.code,'manifest_integrity_mismatch')

    def test_unknown_software_machine_rejected(self):
        with self.assertRaises(ImportValidationError) as error:self.parse(unknown_canonical=True)
        self.assertEqual(error.exception.code,'unknown_machine_reference')

    def test_duplicate_questions_rejected(self):
        with self.assertRaises(ImportValidationError) as error:self.parse(duplicate_question=True)
        self.assertEqual(error.exception.code,'duplicate_question_id')

    def test_zip_slip_is_rejected_without_extraction(self):
        with self.assertRaises(ImportValidationError) as error:self.parse(extra_entries=[('../escape.txt',b'bad')])
        self.assertEqual(error.exception.code,'unsafe_archive_path')
        self.assertFalse((self.root.parent/'escape.txt').exists())

    def test_duplicate_archive_entry_rejected(self):
        with self.assertRaises(ImportValidationError) as error:self.parse(extra_entries=[('data/software.csv',b'bad')])
        self.assertEqual(error.exception.code,'duplicate_archive_entry')

    def test_declared_expanded_size_limit_is_checked(self):
        pair=make_pair(self.root)
        with patch('inventory_service.importer.MAX_EXPANDED',100):
            with self.assertRaises(ImportValidationError) as error:Importer.parse(*pair, archive_password=TEST_ARCHIVE_PASSWORD)
        self.assertEqual(error.exception.code,'archive_expanded_limit')

    def test_blank_answer_is_not_no_license(self):
        result=self.parse(answer='')
        self.assertEqual(result['dataset']['questions'][0]['evidence'],'unknown')
        self.assertEqual(result['dataset']['summary']['directMissing'],0)

    def test_actor_supplied_markup_stays_data(self):
        result=self.parse(answer='<script>alert(1)</script>')
        self.assertEqual(result['dataset']['questions'][0]['answer'],'<script>alert(1)</script>')
        self.assertEqual(result['dataset']['summary']['directMissing'],0)




class ArchivePasswordContractTests(unittest.TestCase):
    def test_missing_unreadable_empty_and_oversized_files_are_configuration_errors(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "owned-password"
            with patch.dict("os.environ", {}, clear=True):
                with self.assertRaises(ArchivePasswordConfigurationError):
                    archive_password_from_file()
            with self.assertRaises(ArchivePasswordConfigurationError):
                archive_password_from_file(path)
            for value in (b"", b"x" * 4097):
                path.write_bytes(value)
                with self.assertRaises(ArchivePasswordConfigurationError):
                    archive_password_from_file(path)

    def test_exact_configured_bytes_decrypt_without_entering_result(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "owned-password"
            password = b" synthetic-secret-with-exact-whitespace\n"
            path.write_bytes(password)
            pair = make_pair(folder, password=password)
            with patch.dict("os.environ", {"INVENTORY_ARCHIVE_PASSWORD_FILE": str(path)}, clear=True):
                self.assertEqual(archive_password_from_file(), password)
                result = Importer.parse(*pair)
            self.assertEqual(result["dataset"]["summary"]["directMissing"], 1)
            self.assertNotIn(password.decode().strip(), json.dumps(result))

    def test_missing_config_fails_before_reading_input_files(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(ArchivePasswordConfigurationError):
                Importer.parse("not-opened.xlsx", "not-opened.zip")


if __name__ == "__main__":
    unittest.main()
