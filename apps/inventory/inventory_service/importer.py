"""Validated, bounded import of SoftwareInventory Excel/AES ZIP pairs."""
from __future__ import annotations
import copy
import csv
import hashlib
import io
import json
import os
import re
import stat
import uuid
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

def bucket(name, publisher=''):
    text = name.lower()
    if re.search(r'\bscad\b', text): return 'SCAD'
    if re.search(r'adobe|acrobat|photoshop|illustrator|indesign', text + ' ' + publisher.lower()): return 'Adobe'
    if re.search(r'(^|[^\w])(1с|1c)[:\s]|1cv8', text): return '1С'
    if re.search(r'cryptopro|криптопро', text): return 'КриптоПро'
    if re.search(r'^pilot-bim\b', text): return 'Pilot-BIM'
    if re.search(r'компас|kompas', text): return 'КОМПАС'
    if re.search(r'lira|лира', text): return 'ЛИРА'
    if re.search(r'microsoft.*(office|visio|project)|майкрософт.*(office|visio|project)|office.*(microsoft|click)|правопис|korrekturhilfen|teams meeting add-in|proofing', text): return 'Office / Visio / Project'
    return 'Другое ПО'

DEVELOPERS = [
    ('1С',r'^1[сc](?:[- ](?:софт|soft))?$',r'^1[сc](?::|\s+предприятие)', 'https://1c.ru/rus/firm1c/firm1c.htm'),
    ('АСКОН',r'^(?:аскон|ascon)$',r'^компас-', 'https://ascon.ru/'),
    ('КриптоПро',r'крипто.?про|cryptopro',r'^криптопро\b','https://cryptopro.ru/about'),
    ('МойОфис',r'новые облачные технологии|myoffice|мойофис',r'^(?:мойофис|myoffice)\b','https://myoffice.ru/about/'),
    ('Лаборатория Касперского',r'касперского|kaspersky',r'^(?:kaspersky\s+endpoint\s+security|агент администрирования kaspersky)','https://www.kaspersky.ru/about/company'),
    ('Контур',r'контур|kontur',r'^(?:контур[. ]|kontur\.)','https://kontur.ru/about'),
    ('Тензор',r'^(?:tensor|тензор)$',r'^(?:saby)(?:\s|$)','https://tensor.ru/'),
    ('Актив',r'^(?:aktiv co\.?|компания [«"“]?актив)',r'^(?:рутокен|rutoken)\b','https://www.aktiv-company.ru/'),
    ('Аладдин Р.Д.',r'^aladdin r\.?d\.?$',r'^(?:единый клиент jacarta|jc-webclient)','https://aladdin-rd.ru/'),
    ('Яндекс',r'яндекс|yandex',r'^(?:a025c540\.yandex\.|яндекс[ .]|yandex(?:disk|[ .]))','https://www.yandex.ru/company/main'),
    ('АТОЛ',r'атол|\batol\b',r'^(?:атол|atol)\b','https://www.atol.ru/'),
]

def russian_developer(r):
    publisher = r['publisher'].lower().replace('\xa0',' ')
    name = r['product'].lower().replace('\xa0',' ')
    # CAPICOM is a Microsoft component even when repackaged by an integrator.
    if name.startswith('capicom'): return None
    for developer,publisher_pattern,name_pattern,url in DEVELOPERS:
        if re.search(publisher_pattern,publisher) or (re.search(name_pattern,name) and (not publisher or publisher.startswith('cn='))):
            return developer,url
    return None

def question_bucket(q):
    key = q['key']
    if key.startswith('OfficeActivation.'): return 'Office / Visio / Project'
    if key.startswith('WindowsActivation.'): return 'Windows'
    if key.startswith('ServerLicense.'): return q['product']
    if key.startswith('Scope'): return 'Охват'
    return bucket(q['product'])

def assessment(q):
    answer = q['answer'].strip()
    negative = bool(re.fullmatch(r'(?:без лицензии|нет лицензии|лицензии нет|лицензий .+ нет)', answer, re.I))
    if not q['key'].startswith('Scope') and re.search(r'\b(?:удалил[аи]?|удал[её]н[аоы]?)\b', q['comment'] + ' ' + answer, re.I):
        return 'removed', 'Удалено по сообщению администратора; повторный сбор не выполнен.'
    if re.search(r'(?:пош[её]л|буду|планирую|собираюсь)\s+удалять', answer + ' ' + q['comment'], re.I):
        return 'conditional', 'Администратор сообщил о намерении удалить ПО. Факт удаления не подтверждён.'
    if re.fullmatch(r'демонстрационная', answer, re.I):
        return 'conditional', 'Администратор указал демонстрационный режим. Условия и срок использования требуют уточнения.'
    if negative and re.search(r'add.in', q['product'], re.I):
        return 'conditional', 'Ответ относится к Teams Add-in. Лицензия основного пакета требует уточнения.'
    if negative and re.search(r'токен', q['comment'], re.I):
        return 'conditional', 'В комментарии указаны токены со встроенной лицензией; требуется уточнение.'
    if negative:
        return 'missing', 'Администратор прямо указал отсутствие лицензии по этому продукту.'
    return 'unknown', ''


MAX_ARCHIVE_PASSWORD_BYTES = 4096


class ArchivePasswordConfigurationError(RuntimeError):
    code = "archive_password_not_configured"
    message = "Проверка архивов не настроена. Обратитесь к администратору установки."


def archive_password_from_file(path=None):
    """Read exact raw secret bytes only when an import is requested."""
    configured = path if path is not None else os.environ.get("INVENTORY_ARCHIVE_PASSWORD_FILE")
    if not configured:
        raise ArchivePasswordConfigurationError()
    try:
        with Path(configured).open("rb") as stream:
            value = stream.read(MAX_ARCHIVE_PASSWORD_BYTES + 1)
    except OSError as exc:
        raise ArchivePasswordConfigurationError() from exc
    if not value or len(value) > MAX_ARCHIVE_PASSWORD_BYTES:
        raise ArchivePasswordConfigurationError()
    return value
MAX_UPLOAD = 64 * 1024 * 1024
MAX_EXPANDED = 512 * 1024 * 1024
MAX_MEMBER = 256 * 1024 * 1024
MAX_ROWS = 500_000
MAX_ENTRIES = 20_000
MAX_FIELD = 1_048_576
csv.field_size_limit(MAX_FIELD)
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
TABLES = {
    'software.csv': ('CanonicalId','Branch','ComputerName','Name','Version','Publisher','Scope','Architecture'),
    'office.csv': ('CanonicalId','Branch','ComputerName','Product','Version','ActivationStatus','LicenseChannel'),
    'machines.csv': ('CanonicalId','Branch','ComputerName','WindowsCaption','WindowsVersion','WindowsActivation','WindowsChannel','CollectedAtUtc'),
    'coverage.csv': ('CanonicalId','Branch','ComputerName','Scope','Status','Expected'),
    'questions.csv': ('QuestionId','Branch','ComputerName','CanonicalId','Product','Key','Question'),
    'priority-software.csv': ('CanonicalId','Branch','ComputerName','Name','Version','Publisher','Family','FamilyId','QuestionKey'),
    'sections.csv': ('CanonicalId','Branch','ComputerName','Section','Status'),
    'attempts.csv': ('CampaignId','ComputerName'),
    'server-products.csv': ('CanonicalId','Branch','ComputerName','Product','Version'),
    'virtualization.csv': ('CanonicalId','Branch','ComputerName'),
}
DATA_LISTS = ('sources','questions','coverage','software','office','windows','licensing','priority',
              'catalogPriority','sections','attempts','servers','virtualization','developerReferences')
SECRET = re.compile(r'password|secret|partial.?key|product.?key|activation.?key|license.?key|private.?key|^key$|serial.?number|(^|_)pin($|_)|(^|_)token($|_)|installation.?id|confirmation.?id', re.I)


class ImportValidationError(ValueError):
    status = 400

    def __init__(self, code, message=None):
        self.code = code
        super().__init__(message or code)


def _fail(code, message=None):
    raise ImportValidationError(code, message)


def _timestamp(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z','+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(timezone.utc).isoformat()
    except (ValueError, TypeError):
        _fail('invalid_snapshot_timestamp')


def _zip_catalog(archive):
    entries = archive.infolist()
    if len(entries) > MAX_ENTRIES:
        _fail('too_many_archive_entries')
    total = 0
    seen = set()
    for info in entries:
        name = info.filename
        path = PurePosixPath(name)
        if (not name or '\\' in name or '\x00' in name or ':' in name or path.is_absolute()
                or any(p in ('..','.') for p in name.split('/'))):
            _fail('unsafe_archive_path')
        normalized = name.casefold().rstrip('/')
        if normalized in seen:
            _fail('duplicate_archive_entry')
        seen.add(normalized)
        mode = (info.external_attr >> 16) & 0xffff
        if stat.S_ISLNK(mode):
            _fail('archive_symlink_not_allowed')
        if info.file_size > MAX_MEMBER or info.file_size < 0:
            _fail('archive_member_too_large')
        total += info.file_size
        if total > MAX_EXPANDED:
            _fail('archive_expanded_limit')
    return {i.filename: i for i in entries if not i.is_dir()}


def _read(archive, catalog, name):
    if name not in catalog:
        _fail('missing_archive_file', f'В архиве отсутствует {name}')
    limit = min(catalog[name].file_size, MAX_MEMBER)
    with archive.open(name) as source:
        value = source.read(limit + 1)
    if len(value) != catalog[name].file_size or len(value) > MAX_MEMBER:
        _fail('archive_member_size_mismatch')
    return value


def _json(value):
    if len(value)>16*1024*1024:
        _fail('json_size_limit')
    def unique(pairs):
        result = {}
        for key, val in pairs:
            if key in result:
                _fail('duplicate_json_key')
            result[key] = val
        return result
    return json.loads(value.decode('utf-8-sig'), object_pairs_hook=unique)


def _xml(value):
    if len(value)>32*1024*1024:
        _fail('xml_size_limit')
    upper = value.upper()
    if b'<!DOCTYPE' in upper or b'<!ENTITY' in upper:
        _fail('xml_entities_not_allowed')
    return ET.fromstring(value)


def _workbook(path):
    with zipfile.ZipFile(path) as archive:
        catalog = _zip_catalog(archive)
        strings = []
        if 'xl/sharedStrings.xml' in catalog:
            strings = [''.join(t.text or '' for t in item.findall('.//s:t', NS))
                       for item in _xml(_read(archive,catalog,'xl/sharedStrings.xml'))]
        relations = {}
        for item in _xml(_read(archive,catalog,'xl/_rels/workbook.xml.rels')):
            target = item.get('Target','')
            if item.get('TargetMode') == 'External':
                continue
            target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            if '..' in PurePosixPath(target).parts:
                _fail('unsafe_workbook_relationship')
            relations[item.get('Id')] = target
        sheets = {}
        row_count = 0
        sheet_list = _xml(_read(archive,catalog,'xl/workbook.xml')).find('s:sheets',NS)
        if sheet_list is None:
            _fail('missing_workbook_sheets')
        for sheet in sheet_list:
            name = sheet.get('name')
            if name not in ('Сводка','Вопросы','Охват'):
                continue
            if name in sheets:
                _fail('duplicate_workbook_sheet')
            target = relations.get(sheet.get('{'+REL_NS+'}id'))
            if not target:
                _fail('missing_workbook_relationship')
            rows = {}
            for row in _xml(_read(archive,catalog,target)).findall('s:sheetData/s:row',NS):
                row_count += 1
                if row_count > MAX_ROWS:
                    _fail('workbook_row_limit')
                values = {}
                for cell in row:
                    ref = cell.get('r','')
                    if not re.fullmatch(r'[A-Z]+[1-9][0-9]*', ref):
                        _fail('invalid_cell_reference')
                    key = re.sub(r'\d','',ref)
                    if key in values:
                        _fail('duplicate_cell')
                    node = cell.find('s:v',NS)
                    val = node.text or '' if node is not None else ''
                    if cell.get('t') == 's':
                        try:
                            val = strings[int(val)]
                        except (ValueError,IndexError):
                            _fail('invalid_shared_string')
                    elif cell.get('t') == 'inlineStr':
                        val = ''.join(t.text or '' for t in cell.findall('.//s:t',NS))
                    if len(val) > MAX_FIELD:
                        _fail('workbook_cell_limit')
                    values[key] = val
                number = int(row.get('r','0'))
                if number in rows:
                    _fail('duplicate_workbook_row')
                rows[number] = values
            sheets[name] = rows
    if set(sheets) != {'Сводка','Вопросы','Охват'}:
        _fail('missing_workbook_sheets')
    return sheets


def _csv(value, columns):
    text = value.decode('utf-8-sig')
    first = text.splitlines()[0] if text else ''
    delimiter = ';' if first.count(';') > first.count(',') else ','
    reader = csv.DictReader(io.StringIO(text),delimiter=delimiter)
    fields = reader.fieldnames or []
    if len(fields) != len(set(fields)) or not set(columns).issubset(fields):
        _fail('invalid_csv_schema')
    rows = []
    for row in reader:
        if None in row or any(v is None for v in row.values()):
            _fail('invalid_csv_row')
        rows.append(row)
        if len(rows) > MAX_ROWS:
            _fail('csv_row_limit')
    return rows


def _safe_name(value):
    return Path(str(value).replace('\\','/')).name[:250]


def summarize(data):
    key = lambda r: (r['branch'],r['canonical'])
    missing = {key(q) for q in data['questions'] if q['evidence']=='missing'}
    conditional = {key(q) for q in data['questions'] if q['evidence']=='conditional'}
    raw = {key(q) for q in data['questions'] if re.fullmatch(r'(?:без лицензии|нет лицензии|лицензии нет|лицензий .+ нет)',q['answer'].strip(),re.I)}
    return {'directMissing':len(missing),'conditionalOnly':len(conditional-missing),'rawMissing':len(raw),
            'eligible':sum(r.get('expected')=='True' for r in data['coverage']),
            'notCollected':sum(r.get('rawStatus')=='Missing' for r in data['coverage']),
            'excluded':sum(r.get('rawStatus')=='Excluded' for r in data['coverage'])}


def merge_datasets(datasets):
    result = {name:[] for name in DATA_LISTS}
    references = {}
    for data in datasets:
        for name in DATA_LISTS:
            if name == 'developerReferences':
                for entry in data.get(name,[]): references[entry['name']] = entry
            else:
                result[name].extend(copy.deepcopy(data.get(name,[])))
    result['developerReferences'] = list(references.values())
    # Rebuild indices after merging branches; per-import indices are not global.
    qmap = defaultdict(list)
    for index,q in enumerate(result['questions']): qmap[(q['branch'],q['canonical'])].append(index)
    for machine in result['licensing']:
        machine['questionIndices'] = qmap[(machine['branch'],machine['canonical'])]
    result['summary'] = summarize(result)
    return result


class Importer:
    @staticmethod
    def parse(xlsx_path, zip_path, *, xlsx_name=None, archive_name=None, archive_password=None):
        password = archive_password_from_file() if archive_password is None else archive_password
        if not isinstance(password, bytes) or not password or len(password) > MAX_ARCHIVE_PASSWORD_BYTES:
            raise ArchivePasswordConfigurationError()
        try:
            return Importer._parse(Path(xlsx_path),Path(zip_path),xlsx_name,archive_name,password)
        except ImportValidationError:
            raise
        except (zipfile.BadZipFile,RuntimeError,UnicodeError,ValueError,KeyError,TypeError,AttributeError,IndexError,ET.ParseError,EOFError,csv.Error) as exc:
            raise ImportValidationError('invalid_import_files','Не удалось прочитать или сопоставить Excel и архив.') from exc

    @staticmethod
    def _parse(xlsx_path, zip_path, xlsx_name, archive_name, password):
        for path in (xlsx_path,zip_path):
            if not path.is_file() or path.stat().st_size > MAX_UPLOAD:
                _fail('upload_size_limit')
        try:
            import pyzipper
        except ImportError as exc:
            raise RuntimeError('pyzipper dependency is required') from exc
        book = _workbook(xlsx_path)
        excel_summary = {r.get('A'):r.get('B') for r in book['Сводка'].values()}
        branch = excel_summary.get('Филиал','').strip()
        campaign_id = excel_summary.get('CampaignId','').strip().lower()
        if not branch or len(branch)>200:
            _fail('invalid_branch')
        try:
            uuid.UUID(campaign_id)
        except ValueError:
            _fail('invalid_campaign_id')
        with pyzipper.AESZipFile(zip_path) as archive:
            archive.setpassword(password)
            catalog = _zip_catalog(archive)
            used = ['manifest.json','source/campaign.json','data/summary.json']+['data/'+name for name in TABLES]
            if any(name not in catalog for name in used):
                _fail('missing_archive_file')
            if any(not catalog[name].flag_bits & 1 or getattr(catalog[name],'wz_aes_strength',0)!=3 for name in used):
                _fail('archive_encryption_required')
            manifest = _json(_read(archive,catalog,'manifest.json'))
            metadata = _json(_read(archive,catalog,'source/campaign.json'))
            summary = _json(_read(archive,catalog,'data/summary.json'))
            for obj in (manifest,metadata,summary):
                if str(obj.get('CampaignId','')).lower()!=campaign_id or obj.get('Branch')!=branch:
                    _fail('pair_identity_mismatch','Excel и архив относятся к разным кампаниям или филиалам.')
            files = manifest.get('Files',[])
            hashes = {}
            for entry in files:
                name = entry.get('Path')
                if name in hashes:
                    _fail('duplicate_manifest_path')
                hashes[name] = entry
            tables = {}
            total_rows = 0
            for name, columns in TABLES.items():
                full = 'data/'+name
                value = _read(archive,catalog,full)
                expected = hashes.get(full)
                if not expected or expected.get('SHA256','').lower()!=hashlib.sha256(value).hexdigest() or expected.get('SizeBytes')!=len(value):
                    _fail('manifest_integrity_mismatch')
                tables[name] = _csv(value,columns)
                total_rows += len(tables[name])
                if total_rows > MAX_ROWS:
                    _fail('csv_total_row_limit')
            for filename,obj in [('source/campaign.json',metadata),('data/summary.json',summary)]:
                value = _read(archive,catalog,filename)
                expected = hashes.get(filename)
                if not expected or expected.get('SHA256','').lower()!=hashlib.sha256(value).hexdigest() or expected.get('SizeBytes')!=len(value):
                    _fail('manifest_integrity_mismatch')
        generated = summary.get('GeneratedAtUtc')
        if _timestamp(excel_summary.get('Сформировано (UTC)')) != _timestamp(generated):
            _fail('pair_generation_mismatch')
        snapshot = _timestamp(summary.get('AdSnapshotCapturedAtUtc') or metadata.get('CreatedAtUtc') or generated)
        for name,rows in tables.items():
            for row in rows:
                if 'Branch' in row and row['Branch']!=branch:
                    _fail('csv_branch_mismatch')
                if name=='attempts.csv' and row['CampaignId'].lower()!=campaign_id:
                    _fail('csv_campaign_mismatch')
        coverage_ids = [r['CanonicalId'] for r in tables['coverage.csv']]
        machine_ids = [r['CanonicalId'] for r in tables['machines.csv']]
        machine_set = set(machine_ids)
        if len(set(coverage_ids))!=len(coverage_ids) or len(set(machine_ids))!=len(machine_ids) or not set(machine_ids).issubset(coverage_ids):
            _fail('invalid_machine_identity')
        if any(not value or len(value)>300 for value in coverage_ids):
            _fail('invalid_machine_identity')
        for name in ('software.csv','office.csv','priority-software.csv','sections.csv','server-products.csv','virtualization.csv'):
            if any(r['CanonicalId'] not in machine_set for r in tables[name]):
                _fail('unknown_machine_reference')
        xname = _safe_name(xlsx_name or xlsx_path.name)
        zname = _safe_name(archive_name or zip_path.name)
        data = {name:[] for name in DATA_LISTS}
        data['sources'].append({'name':xname,'archive':zname,'branch':branch,'generated':generated,'campaignId':campaign_id,'snapshotAt':snapshot})
        question_map = {}
        for row in tables['questions.csv']:
            if row['QuestionId'] in question_map:
                _fail('duplicate_question_id')
            if row['CanonicalId'] not in set(coverage_ids) and not row['Key'].startswith('Scope.'):
                _fail('unknown_question_machine')
            question_map[row['QuestionId']] = row
        question_fields = {'machine':'B','product':'C','question':'D','answer':'E','comment':'F','originalState':'G','id':'H','canonical':'I','key':'J'}
        seen = set()
        for number,row in book['Вопросы'].items():
            if number < 5 or not any(row.values()): continue
            q = {name:row.get(col,'') for name,col in question_fields.items()}
            if not q['id'] or q['id'] in seen or q['id'] not in question_map:
                _fail('question_identity_mismatch')
            seen.add(q['id'])
            original = question_map[q['id']]
            for a,b in [('machine','ComputerName'),('product','Product'),('question','Question'),('canonical','CanonicalId'),('key','Key')]:
                if q[a] != original[b]: _fail('question_identity_mismatch')
            if row.get('A') != branch: _fail('question_branch_mismatch')
            q.update(branch=branch,source=xname,sourceRow=number)
            q['bucket'] = question_bucket(q)
            q['evidence'],q['assessmentNote'] = assessment(q)
            data['questions'].append(q)
        if seen != set(question_map): _fail('question_identity_mismatch')
        coverage_rows = [r for n,r in book['Охват'].items() if n>=5 and any(r.values())]
        xcoverage = {r.get('I'):r for r in coverage_rows}
        if len(xcoverage)!=len(coverage_rows): _fail('duplicate_workbook_machine')
        if set(xcoverage) != set(coverage_ids): _fail('coverage_identity_mismatch')
        scope_names={'Eligible':'AD: опрашиваем','ExcludedDisabled':'AD: объект отключён','ExcludedNonWindows':'AD: другая ОС'}
        status_names={'Success':'Базовые данные собраны','Partial':'Базовые данные собраны частично','Missing':'Нет результата','Excluded':'Исключён из опроса'}
        for number,row in enumerate(tables['coverage.csv'],2):
            xr = xcoverage[row['CanonicalId']]
            if xr.get('A')!=row['ComputerName'] or xr.get('B')!=row.get('Domain',''):
                _fail('coverage_identity_mismatch')
            data['coverage'].append({'branch':branch,'canonical':row['CanonicalId'],'machine':row['ComputerName'],'domain':row.get('Domain',''),
                'scope':xr.get('C',scope_names.get(row['Scope'],row['Scope'])),'result':xr.get('D',status_names.get(row['Status'],row['Status'])),
                'reason':row.get('Reason',''),'collected':row.get('CollectedAtUtc',''),'transport':row.get('Transport',''),
                'expected':row['Expected'],'rawStatus':row['Status'],'source':zname,'sourceTable':'coverage.csv','sourceRow':number})
        targets={'software.csv':'software','office.csv':'office','machines.csv':'windows','priority-software.csv':'catalogPriority','sections.csv':'sections','attempts.csv':'attempts','server-products.csv':'servers','virtualization.csv':'virtualization'}
        for name,target in targets.items():
            for number,row in enumerate(tables[name],2):
                r={'branch':branch,'canonical':row.get('CanonicalId',''),'machine':row['ComputerName'],'source':zname,'sourceTable':name,'sourceRow':number,
                   'details':{k:v for k,v in row.items() if v and k not in ('Branch','CanonicalId','ComputerName') and not SECRET.search(k)}}
                if target=='software':
                    r.update(product=row['Name'],version=row['Version'],publisher=row['Publisher'],bucket=bucket(row['Name'],row['Publisher']),scope=row['Scope'],architecture=row['Architecture'])
                elif target=='office':
                    r.update(product=row['Product'],version=row['Version'],publisher='Microsoft',bucket='Office / Visio / Project',activation=row['ActivationStatus'],channel=row['LicenseChannel'],installation=row.get('InstallationEvidence',''),architecture=row.get('Architecture',''))
                elif target=='windows':
                    r.update(product=row['WindowsCaption'],version=row['WindowsVersion'],publisher='Microsoft',bucket='Windows',activation=row['WindowsActivation'],channel=row['WindowsChannel'],collected=row['CollectedAtUtc'])
                elif target=='catalogPriority':
                    r.update(product=row['Name'],version=row['Version'],publisher=row['Publisher'],family=row['Family'],familyId=row['FamilyId'],questionKey=row['QuestionKey'],bucket=bucket(row['Name'],row['Publisher']),scope=row.get('Scope',''))
                elif target=='servers':
                    r.update(product=row['Product'],version=row['Version'],bucket='SQL Server' if row['Product']=='SQL' else row['Product'])
                data[target].append(r)
        catalog_index=defaultdict(list)
        for r in data['catalogPriority']: catalog_index[(r['canonical'],r['product'].lower(),r['version'])].append(r)
        for r in data['software']:
            identified=russian_developer(r)
            if not identified: continue
            developer,url=identified
            r['developer']=developer
            if r['bucket']=='Другое ПО': r['bucket']=developer
            priority=copy.deepcopy(r)
            matches=catalog_index[(r['canonical'],r['product'].lower(),r['version'])]
            priority.update(developer=developer,family=developer,questionKey=matches[0]['questionKey'] if matches else '')
            priority['details'].update(RussianDeveloper=developer,DeveloperReference=url)
            data['priority'].append(priority)
        data['developerReferences']=[{'name':d,'url':u} for d,_,_,u in DEVELOPERS]
        qindex=defaultdict(list)
        for n,q in enumerate(data['questions']): qindex[q['canonical']].append(n)
        groups=defaultdict(set)
        office=defaultdict(set)
        for r in data['software']+data['office']+data['windows']+data['servers']: groups[r['canonical']].add(r['bucket'])
        for r in data['office']: office[r['canonical']].add(r['activation'])
        for machine in data['windows']:
            r={k:machine[k] for k in ('branch','canonical','machine','source','product')}
            r.update(groups=sorted(groups[r['canonical']]),questionIndices=qindex[r['canonical']],activationWindows=machine['activation'],activationOffice=sorted(office[r['canonical']]))
            data['licensing'].append(r)
        data['summary']=summarize(data)
        digest=hashlib.sha256()
        for path in (xlsx_path,zip_path):
            with path.open('rb') as source:
                for chunk in iter(lambda:source.read(1024*1024),b''): digest.update(chunk)
        fingerprint=digest.hexdigest()
        return {'dataset':data,'metadata':{'branch':branch,'campaign_id':campaign_id,'snapshot_at':snapshot,'generated_at':generated,
            'xlsx_name':xname,'archive_name':zname,'counts':{k:len(v) for k,v in data.items() if isinstance(v,list)}},'fingerprint':fingerprint}
