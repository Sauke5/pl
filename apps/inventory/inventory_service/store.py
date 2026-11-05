"""Transactional, revision-preserving inventory storage.

The active branch pointer changes in the same SQLite transaction as revision
creation. Preview tokens are bound to the uploading Platform subject.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import sqlite3
import time
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from .importer import DATA_LISTS, merge_datasets

PREVIEW_TTL = 24 * 60 * 60
MAX_BOOTSTRAP_PAGE = 2 * 1024 * 1024


class StoreError(ValueError):
    def __init__(self, code, status=409, message=None):
        self.code, self.status = code, status
        super().__init__(message or code)


def _actor(actor):
    value = actor.get('sub') if isinstance(actor,dict) else actor
    if not isinstance(value,str) or not value or len(value)>256:
        raise StoreError('invalid_actor',400)
    return value


def _branch(value):
    if not isinstance(value,str) or not value.strip():
        raise StoreError('invalid_branch',400)
    return unicodedata.normalize('NFKC',value).strip().casefold()


def _pack(data):
    return gzip.compress(json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode(),mtime=0)


def _unpack(payload):
    return json.loads(gzip.decompress(payload))


def _older(left,right):
    return datetime.fromisoformat(left.replace('Z','+00:00')) < datetime.fromisoformat(right.replace('Z','+00:00'))


def _norm(value):
    return str(value or '').casefold().replace('ё','е')


def _software_records(data):
    questions={}
    catalog={}
    office={}
    key=lambda r:(r['branch'],r['canonical'],_norm(r['product']),r.get('version',''))
    for q in data['questions']:
        questions.setdefault((q['branch'],q['canonical']),[]).append(q)
    for row in data['catalogPriority']:
        catalog.setdefault(key(row),set()).add(row.get('questionKey',''))
    for row in data['office']:
        office.setdefault(key(row),set()).add(row.get('activation','Unknown'))
    russian={key(row) for row in data['priority']}
    for original in data['software']:
        row=dict(original)
        qs=[q for q in questions.get((row['branch'],row['canonical']),[]) if _norm(q['product'])==_norm(row['product']) or q['key'] in catalog.get(key(row),set())]
        row['qs']=qs
        row['answer']='\n\n'.join(dict.fromkeys(q['answer'] for q in qs if q['answer'].strip()))
        row['comment']='\n\n'.join(dict.fromkeys(q['comment'] for q in qs if q['comment'].strip()))
        states={q['evidence'] for q in qs}
        row['evidence']=next((s for s in ('missing','conditional','removed') if s in states),'unknown')
        row['activationStates']=sorted(office.get(key(row),set()))
        row['activation']=row['activationStates'][0] if len(row['activationStates'])==1 else 'Multiple' if row['activationStates'] else 'Unavailable'
        row['notactivated']='NotActivated' in row['activationStates']
        row['priority']=key(row) in russian
        yield row


class Store:
    def __init__(self,data_dir):
        self.directory=Path(data_dir)
        self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path=self.directory/'inventory.sqlite3'
        with self._db() as connection:
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS imports (
                    id TEXT PRIMARY KEY, branch_key TEXT NOT NULL, branch TEXT NOT NULL,
                    campaign_id TEXT NOT NULL, snapshot_at TEXT NOT NULL,
                    fingerprint TEXT NOT NULL UNIQUE, payload BLOB NOT NULL,
                    metadata TEXT NOT NULL, actor TEXT NOT NULL, created_at REAL NOT NULL, bootstrap BLOB
                );
                CREATE TABLE IF NOT EXISTS active (
                    branch_key TEXT PRIMARY KEY, import_id TEXT NOT NULL REFERENCES imports(id)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS active_import ON active(import_id);
                CREATE TABLE IF NOT EXISTS previews (
                    token TEXT PRIMARY KEY, actor TEXT NOT NULL, created_at REAL NOT NULL,
                    parsed BLOB, receipt TEXT
                );
                CREATE INDEX IF NOT EXISTS imports_branch ON imports(branch_key,created_at);
                CREATE TABLE IF NOT EXISTS software_rows (
                    import_id TEXT NOT NULL REFERENCES imports(id), row_no INTEGER NOT NULL,
                    branch TEXT NOT NULL, canonical TEXT NOT NULL, machine TEXT NOT NULL,
                    machine_key TEXT NOT NULL, product TEXT NOT NULL, version TEXT NOT NULL,
                    publisher TEXT NOT NULL, bucket TEXT NOT NULL, evidence TEXT NOT NULL,
                    has_answer INTEGER NOT NULL, not_activated INTEGER NOT NULL,
                    search_text TEXT NOT NULL, row_json TEXT NOT NULL,
                    PRIMARY KEY(import_id,row_no)
                );
                CREATE INDEX IF NOT EXISTS software_branch_bucket ON software_rows(import_id,branch,bucket);
                CREATE INDEX IF NOT EXISTS software_machine ON software_rows(import_id,machine_key);
                CREATE INDEX IF NOT EXISTS software_evidence ON software_rows(import_id,evidence,has_answer);
                CREATE INDEX IF NOT EXISTS software_version ON software_rows(import_id,version);
            ''')
            if 'bootstrap' not in {r[1] for r in connection.execute('PRAGMA table_info(imports)')}:
                connection.execute('ALTER TABLE imports ADD COLUMN bootstrap BLOB')
        os.chmod(self.path,0o600)

    @contextmanager
    def _db(self):
        connection=sqlite3.connect(self.path,timeout=30)
        connection.row_factory=sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        connection.execute('PRAGMA journal_mode=WAL')
        try:
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def preview(self,parsed,actor):
        subject=_actor(actor)
        try:
            metadata=parsed['metadata']
            branch_key=_branch(metadata['branch'])
            datetime.fromisoformat(metadata['snapshot_at'].replace('Z','+00:00'))
            if len(parsed['fingerprint'])!=64 or any(k not in parsed['dataset'] for k in DATA_LISTS):
                raise ValueError()
        except (ValueError,TypeError,KeyError) as exc:
            raise StoreError('invalid_preview_data',400) from exc
        now=time.time()
        token=str(uuid.uuid4())
        with self._db() as connection:
            connection.execute('DELETE FROM previews WHERE created_at < ?',(now-PREVIEW_TTL,))
            duplicate=connection.execute('SELECT id FROM imports WHERE fingerprint=?',(parsed['fingerprint'],)).fetchone()
            current=connection.execute('SELECT i.id,i.snapshot_at,i.metadata FROM imports i JOIN active a ON a.import_id=i.id WHERE a.branch_key=?',(branch_key,)).fetchone()
            stale=bool(current and _older(metadata['snapshot_at'],current['snapshot_at']))
            connection.execute('INSERT INTO previews(token,actor,created_at,parsed) VALUES(?,?,?,?)',(token,subject,now,_pack(parsed)))
        return {'token':token,'preview_id':token,'metadata':metadata,'counts':metadata.get('counts',{}),
                'duplicate':bool(duplicate),'stale':stale,'can_commit':bool(duplicate) or not stale,
                'current':json.loads(current['metadata']) if current else None}

    def _receipt(self,row,active,duplicate=False):
        return {'import_id':row['id'],'id':row['id'],'branch':row['branch'],'campaign_id':row['campaign_id'],
                'snapshot_at':row['snapshot_at'],'fingerprint':row['fingerprint'],'metadata':json.loads(row['metadata']),
                'actor':row['actor'],'created_at':row['created_at'],'active':active,'duplicate':duplicate}

    def _activate(self,connection,branch_key,import_id):
        connection.execute('INSERT INTO active(branch_key,import_id) VALUES(?,?) ON CONFLICT(branch_key) DO UPDATE SET import_id=excluded.import_id',(branch_key,import_id))

    def commit(self,token,actor):
        subject=_actor(actor)
        with self._db() as connection:
            connection.execute('BEGIN IMMEDIATE')
            preview=connection.execute('SELECT * FROM previews WHERE token=?',(token,)).fetchone()
            if not preview:
                raise StoreError('preview_not_found',404)
            if preview['actor']!=subject:
                raise StoreError('preview_actor_mismatch',403)
            if time.time()-preview['created_at']>PREVIEW_TTL:
                raise StoreError('preview_expired',409)
            if preview['receipt']:
                return json.loads(preview['receipt'])
            parsed=_unpack(preview['parsed'])
            metadata=parsed['metadata']
            branch_key=_branch(metadata['branch'])
            current=connection.execute('SELECT i.id,i.snapshot_at FROM imports i JOIN active a ON a.import_id=i.id WHERE a.branch_key=?',(branch_key,)).fetchone()
            receipt_columns='id,branch,campaign_id,snapshot_at,fingerprint,metadata,actor,created_at'
            duplicate=connection.execute('SELECT '+receipt_columns+' FROM imports WHERE fingerprint=?',(parsed['fingerprint'],)).fetchone()
            if duplicate:
                receipt=self._receipt(duplicate,bool(current and current['id']==duplicate['id']),True)
            else:
                if current and _older(metadata['snapshot_at'],current['snapshot_at']):
                    raise StoreError('stale_snapshot',409,'Нельзя заменить актуальный снимок более старым.')
                import_id=uuid.uuid4().hex
                bootstrap={**parsed['dataset'],'software':[]}
                connection.execute('INSERT INTO imports(id,branch_key,branch,campaign_id,snapshot_at,fingerprint,payload,metadata,actor,created_at,bootstrap) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                    (import_id,branch_key,metadata['branch'],metadata['campaign_id'],metadata['snapshot_at'],parsed['fingerprint'],_pack(parsed['dataset']),json.dumps(metadata,ensure_ascii=False),subject,time.time(),_pack(bootstrap)))
                def records():
                    for n,row in enumerate(_software_records(parsed['dataset'])):
                        search=_norm(' '.join(str(row.get(k,'')) for k in ('branch','machine','product','version','publisher','bucket','answer','comment','scope','channel')))
                        yield (import_id,n,row['branch'],row['canonical'],row['machine'],row['branch']+'|'+row['canonical'],row['product'],row['version'],row['publisher'],row['bucket'],row['evidence'],int(bool(row['answer'].strip())),int(row['notactivated']),search,json.dumps(row,ensure_ascii=False,separators=(',',':')))
                connection.executemany('INSERT INTO software_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',records())
                self._activate(connection,branch_key,import_id)
                row=connection.execute('SELECT '+receipt_columns+' FROM imports WHERE id=?',(import_id,)).fetchone()
                receipt=self._receipt(row,True)
            connection.execute('UPDATE previews SET receipt=?,parsed=NULL WHERE token=?',(json.dumps(receipt,ensure_ascii=False),token))
            return receipt

    def dataset(self):
        with self._db() as connection:
            rows=connection.execute('SELECT i.payload FROM active a JOIN imports i ON i.id=a.import_id ORDER BY i.branch_key').fetchall()
        return merge_datasets([_unpack(row['payload']) for row in rows])

    def list_imports(self):
        with self._db() as connection:
            rows=connection.execute('SELECT i.id,i.branch,i.campaign_id,i.snapshot_at,i.fingerprint,i.metadata,i.actor,i.created_at, CASE WHEN a.import_id IS NOT NULL THEN 1 ELSE 0 END AS is_active FROM imports i LEFT JOIN active a ON a.import_id=i.id ORDER BY i.created_at DESC').fetchall()
        return [self._receipt(row,bool(row['is_active'])) for row in rows]

    def bootstrap(self):
        return self._bootstrap_snapshot()[0]

    def _bootstrap_snapshot(self):
        with self._db() as connection:
            rows=connection.execute('SELECT i.id,i.bootstrap,i.metadata FROM active a JOIN imports i ON i.id=a.import_id ORDER BY i.branch_key').fetchall()
        parts=[]
        count=0
        for row in rows:
            if row['bootstrap'] is None:
                raise StoreError('unsupported_storage_revision',500)
            part=_unpack(row['bootstrap'])
            parts.append(part)
            count+=json.loads(row['metadata']).get('counts',{}).get('software',0)
        result=merge_datasets(parts)
        result['softwareTotal']=count
        revision=hashlib.sha256(json.dumps([row['id'] for row in rows],separators=(',',':')).encode()).hexdigest()
        return result,revision

    def bootstrap_page(self,page=1,revision=None):
        try:
            page=int(page)
        except (ValueError,TypeError):
            raise StoreError('invalid_pagination',400)
        if not 1<=page<=10_000:
            raise StoreError('invalid_pagination',400)
        if page>1 and not revision:
            raise StoreError('bootstrap_revision_required',400)
        data,current_revision=self._bootstrap_snapshot()
        if revision is not None and revision!=current_revision:
            raise StoreError('snapshot_changed',409,'Состав данных изменился. Обновите инвентаризацию.')
        def blank():
            return {**{name:[] for name in DATA_LISTS},'summary':data['summary'],'softwareTotal':data['softwareTotal']}
        # Reserve more than the maximum envelope size (page, next_page and hash).
        # Bytes added below are exactly JSON row bytes and list commas.
        initial=len(json.dumps(blank(),ensure_ascii=False,separators=(',',':')).encode())+200
        if initial>MAX_BOOTSTRAP_PAGE:
            raise StoreError('bootstrap_row_too_large',413)
        current_page=1
        chunk=blank()
        size=initial
        for name in DATA_LISTS:
            if name=='software':
                continue
            for row in data[name]:
                row_size=len(json.dumps(row,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode())
                if initial+row_size>MAX_BOOTSTRAP_PAGE:
                    raise StoreError('bootstrap_row_too_large',413)
                addition=row_size+int(bool(chunk[name]))
                if size+addition>MAX_BOOTSTRAP_PAGE:
                    if current_page==page:
                        return {'dataset':chunk,'page':page,'next_page':page+1,'revision':current_revision}
                    current_page+=1
                    chunk=blank()
                    size=initial
                    addition=row_size
                chunk[name].append(row)
                size+=addition
        if current_page!=page:
            raise StoreError('bootstrap_page_not_found',404)
        return {'dataset':chunk,'page':page,'next_page':None,'revision':current_revision}

    def software_page(self,params=None):
        params=params or {}
        def number(name,default,minimum,maximum):
            try:
                value=int(params.get(name,default))
            except (ValueError,TypeError):
                raise StoreError('invalid_pagination',400)
            if not minimum<=value<=maximum:
                raise StoreError('invalid_pagination',400)
            return value
        limit=number('limit',25,1,100)
        page=number('page',1,1,1_000_000)
        sort=params.get('sort','branch')
        if sort not in ('branch','machine','product','version','publisher','evidence'):
            raise StoreError('invalid_sort',400)
        direction=params.get('direction','1')
        if str(direction).lower() in ('-1','desc','descending'): direction='DESC'
        elif str(direction).lower() in ('1','asc','ascending'): direction='ASC'
        else: raise StoreError('invalid_sort_direction',400)
        def text(name):
            value=params.get(name,'')
            if not isinstance(value,str) or len(value)>2000:
                raise StoreError('invalid_filter',400)
            return value
        branch,category,machine,version=(text(k) for k in ('branch','category','machine','version'))
        evidence,answer=text('evidence'),text('answer')
        if evidence not in ('','missing','conditional','removed','unknown','notactivated') or answer not in ('','yes','no'):
            raise StoreError('invalid_filter',400)
        conditions=[]
        arguments=[]
        for column,value in [('branch',branch),('bucket',category),('machine_key',machine),('version',version)]:
            if value:
                conditions.append('s.'+column+'=?');arguments.append(value)
        if evidence:
            conditions.append('s.not_activated=1' if evidence=='notactivated' else 's.evidence=?')
            if evidence!='notactivated': arguments.append(evidence)
        if answer:
            conditions.append('s.has_answer=?');arguments.append(int(answer=='yes'))
        tokens=_norm(text('search')).split()
        if len(tokens)>30: raise StoreError('too_many_search_terms',400)
        for token in tokens:
            conditions.append('instr(s.search_text,?)>0');arguments.append(token)
        base=' FROM software_rows s JOIN active a ON a.import_id=s.import_id'
        where=' WHERE '+' AND '.join(conditions) if conditions else ''
        with self._db() as connection:
            connection.execute('BEGIN')
            total=connection.execute('SELECT count(*)'+base+where,arguments).fetchone()[0]
            machine_count=connection.execute('SELECT count(DISTINCT s.machine_key)'+base+where,arguments).fetchone()[0]
            rows=connection.execute('SELECT s.row_json'+base+where+' ORDER BY s.'+sort+' COLLATE NOCASE '+direction+',s.machine COLLATE NOCASE,s.product COLLATE NOCASE,s.row_no LIMIT ? OFFSET ?',arguments+[limit,(page-1)*limit]).fetchall()
            option_where=' WHERE s.branch=?' if branch else ''
            option_args=[branch] if branch else []
            categories=[r[0] for r in connection.execute('SELECT DISTINCT s.bucket'+base+option_where+' ORDER BY s.bucket COLLATE NOCASE',option_args)]
            if category:
                option_where+=(' AND ' if option_where else ' WHERE ')+'s.bucket=?';option_args.append(category)
            machines=[{'value':r[0],'label':r[1]+('' if branch else ' · '+r[2])} for r in connection.execute('SELECT DISTINCT s.machine_key,s.machine,s.branch'+base+option_where+' ORDER BY s.machine COLLATE NOCASE',option_args)]
            if machine:
                option_where+=(' AND ' if option_where else ' WHERE ')+'s.machine_key=?';option_args.append(machine)
            versions=[r[0] for r in connection.execute('SELECT DISTINCT s.version'+base+option_where+(' AND ' if option_where else ' WHERE ')+"s.version!='' ORDER BY s.version COLLATE NOCASE",option_args)]
        return {'rows':[json.loads(r[0]) for r in rows],'total':total,'machine_count':machine_count,'page':page,'limit':limit,
                'options':{'categories':categories,'machines':machines,'versions':versions}}
