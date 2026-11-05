-- Backfill only legacy documents which never had this new field. Explicit empty
-- lists and administrator-defined values remain intact. Record the additive
-- upgrade and advance revision so an open pre-upgrade form cannot overwrite it.
WITH updated AS (
 UPDATE documents
 SET body=jsonb_set(body,'{relation_types}','["Размещено на","Использует БД","Зависит от","Резервируется на"]'::jsonb),
     revision=revision+1, updated_at=now()
 WHERE kind='dictionaries' AND id='global' AND NOT (body ? 'relation_types')
 RETURNING id,revision
), entries AS (
 SELECT gen_random_uuid()::text AS event_id,id,revision FROM updated
)
INSERT INTO audit_events(id,body,created_at)
SELECT event_id,
 jsonb_build_object('id',event_id,'kind','dictionaries.saved','title','Добавлены типы связей','resource_id',id,
                    'actor','system','actor_name','Система','created_at',now(),
                    'details',jsonb_build_object('kind','dictionaries','migration','012_dictionary_relation_types','revision',revision)),
 now()
FROM entries;
