import copy
import hashlib
import json
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from inventory_service.importer import DATA_LISTS
from inventory_service.store import Store, StoreError


def parsed(seed='one',branch='A',snapshot='2026-10-27T10:00:00+00:00',count=1,answer='Нет лицензии'):
    data={name:[] for name in DATA_LISTS}
    q={'branch':branch,'canonical':'ad:1','machine':'PC','id':'question','key':'key','product':'Program','answer':answer,'comment':'','evidence':'missing','question':'License?'}
    data['questions']=[q]
    data['software']=[{'branch':branch,'canonical':'ad:1','machine':'PC','product':'Program','version':str(i),'publisher':'Example','bucket':'Other','scope':'Machine','architecture':'x64','details':{},'source':'a.zip','sourceTable':'software.csv','sourceRow':i+2} for i in range(count)]
    data['licensing']=[{'branch':branch,'canonical':'ad:1','machine':'PC','questionIndices':[0]}]
    data['sources']=[{'branch':branch,'name':'a.xlsx','archive':'a.zip','generated':snapshot}]
    data['summary']={}
    return {'dataset':data,'metadata':{'branch':branch,'campaign_id':'same-campaign','snapshot_at':snapshot,'counts':{k:len(v) for k,v in data.items() if isinstance(v,list)}},'fingerprint':hashlib.sha256(seed.encode()).hexdigest()}


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=Store(self.temp.name)

    def commit(self,item,actor='user'):
        preview=self.store.preview(item,actor)
        self.assertEqual(str(uuid.UUID(preview['token'])),preview['preview_id'])
        return self.store.commit(preview['token'],actor)

    def test_preview_does_not_publish(self):
        self.store.preview(parsed(),'user')
        self.assertEqual(self.store.list_imports(),[])
        self.assertEqual(self.store.bootstrap()['softwareTotal'],0)

    def test_commit_and_same_token_retry_are_idempotent(self):
        preview=self.store.preview(parsed(),'user')
        first=self.store.commit(preview['token'],'user')
        self.assertEqual(first,self.store.commit(preview['token'],'user'))
        second=self.commit(parsed())
        self.assertTrue(second['duplicate'])
        self.assertEqual(first['id'],second['id'])
        self.assertEqual(len(self.store.list_imports()),1)

    def test_preview_is_bound_to_subject(self):
        preview=self.store.preview(parsed(),'one')
        with self.assertRaises(StoreError) as error:self.store.commit(preview['token'],'two')
        self.assertEqual(error.exception.status,403)
        self.assertEqual(self.store.list_imports(),[])

    def test_revised_answers_replace_branch_without_duplicate_machines(self):
        self.commit(parsed())
        self.commit(parsed('two',answer='Updated'))
        data=self.store.dataset()
        self.assertEqual(len(data['software']),1)
        self.assertEqual(data['questions'][0]['answer'],'Updated')
        self.assertEqual(len(self.store.list_imports()),2)
        self.assertEqual(sum(i['active'] for i in self.store.list_imports()),1)

    def test_stale_commit_cannot_overwrite_newer_concurrent_import(self):
        older=self.store.preview(parsed(),'user')
        self.commit(parsed('new',snapshot='2026-10-28T10:00:00+00:00'))
        with self.assertRaises(StoreError) as error:self.store.commit(older['token'],'user')
        self.assertEqual(error.exception.code,'stale_snapshot')
        self.assertEqual(len(self.store.list_imports()),1)

    def test_historical_duplicate_does_not_reactivate_old_snapshot(self):
        old=self.commit(parsed())
        new=self.commit(parsed('new',snapshot='2026-10-28T10:00:00+00:00'))
        duplicate=self.commit(parsed())
        self.assertEqual(duplicate['id'],old['id'])
        self.assertFalse(duplicate['active'])
        self.assertEqual(next(i for i in self.store.list_imports() if i['active'])['id'],new['id'])

    def test_failed_activation_rolls_back_revision_and_index(self):
        original=self.commit(parsed())
        preview=self.store.preview(parsed('two'),'user')
        with patch.object(self.store,'_activate',side_effect=RuntimeError('injected failure')):
            with self.assertRaises(RuntimeError):self.store.commit(preview['token'],'user')
        self.assertEqual(len(self.store.list_imports()),1)
        self.assertEqual(self.store.list_imports()[0]['id'],original['id'])
        self.assertEqual(self.store.software_page()['total'],1)
        self.assertTrue(self.store.commit(preview['token'],'user')['active'])

    def test_concurrent_identical_commits_create_one_revision(self):
        previews=[self.store.preview(parsed(),'user') for _ in range(2)]
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda p:self.store.commit(p['token'],'user'),previews))
        self.assertEqual(results[0]['id'],results[1]['id'])
        self.assertEqual(len(self.store.list_imports()),1)

    def test_merge_rebuilds_question_indices(self):
        self.commit(parsed(branch='A'))
        self.commit(parsed('branchB',branch='B'))
        merged=self.store.dataset()
        for machine in merged['licensing']:
            self.assertEqual(merged['questions'][machine['questionIndices'][0]]['branch'],machine['branch'])

    def test_software_pagination_is_bounded_and_searches_answers(self):
        self.commit(parsed(count=200))
        self.assertEqual(len(self.store.software_page()['rows']),25)
        self.assertEqual(len(self.store.software_page({'limit':'100','page':'2'})['rows']),100)
        self.assertEqual(self.store.software_page({'search':'Нет лицензии'})['total'],200)
        self.assertEqual(self.store.software_page({'search':"' OR 1=1 --"})['total'],0)
        self.assertEqual(self.store.software_page({'machine':'A|ad:1'})['machine_count'],1)
        self.assertEqual(self.store.software_page({'evidence':'missing'})['total'],200)
        self.assertEqual(self.store.software_page({'answer':'no'})['total'],0)
        self.assertEqual(self.store.software_page()['options']['machines'][0]['value'],'A|ad:1')
        with self.assertRaises(StoreError):self.store.software_page({'limit':'101'})
        with self.assertRaises(StoreError):self.store.software_page({'sort':'product; DELETE FROM imports'})

    def test_bootstrap_has_no_full_software_dataset(self):
        self.commit(parsed(count=200))
        result=self.store.bootstrap()
        self.assertEqual(result['software'],[])
        self.assertEqual(result['softwareTotal'],200)
        self.assertEqual(len(result['questions']),1)

    def test_bootstrap_pages_preserve_every_row_and_stay_bounded(self):
        item=parsed(count=200)
        item['dataset']['attempts']=[{'branch':'A','machine':'PC','details':{'attempt':i,'result':'x'*80}} for i in range(30)]
        self.commit(item)
        combined={name:[] for name in DATA_LISTS}
        page=1;revision=None;seen_pages=0
        with patch('inventory_service.store.MAX_BOOTSTRAP_PAGE',1200):
            while page:
                response=self.store.bootstrap_page(page,revision)
                self.assertLessEqual(len(json.dumps(response,ensure_ascii=False,separators=(',',':')).encode()),1200)
                revision=response['revision'];seen_pages+=1
                self.assertEqual(response['dataset']['softwareTotal'],200)
                for name in DATA_LISTS:combined[name].extend(response['dataset'][name])
                page=response['next_page']
        expected=self.store.bootstrap()
        for name in DATA_LISTS:self.assertEqual(combined[name],expected[name])
        self.assertGreater(seen_pages,1)

    def test_bootstrap_revision_prevents_mixing_import_revisions(self):
        self.commit(parsed())
        revision=self.store.bootstrap_page()['revision']
        self.commit(parsed('new'))
        with self.assertRaises(StoreError) as error:self.store.bootstrap_page(2,revision)
        self.assertEqual(error.exception.code,'snapshot_changed')
        self.assertEqual(error.exception.status,409)
        with self.assertRaises(StoreError) as error:self.store.bootstrap_page(2)
        self.assertEqual(error.exception.code,'bootstrap_revision_required')

    def test_bootstrap_rejects_an_indivisible_oversized_row(self):
        item=parsed()
        item['dataset']['attempts']=[{'value':'x'*1500}]
        self.commit(item)
        with patch('inventory_service.store.MAX_BOOTSTRAP_PAGE',1200):
            with self.assertRaises(StoreError) as error:self.store.bootstrap_page()
        self.assertEqual(error.exception.status,413)


if __name__=='__main__':unittest.main()
