-- name: GetDocument :one
SELECT kind,id,revision,body,search_text,updated_at FROM documents WHERE kind=$1 AND id=$2;

-- name: ListDocuments :many
SELECT kind,id,revision,body,search_text,updated_at FROM documents WHERE kind=$1 ORDER BY id;

-- name: InsertDocument :one
INSERT INTO documents(kind,id,body,search_text) VALUES($1,$2,$3,$4) RETURNING *;

-- name: UpdateDocument :one
UPDATE documents SET body=$3,search_text=$4,revision=revision+1,updated_at=now()
WHERE kind=$1 AND id=$2 AND revision=$5 RETURNING *;

-- name: DeleteDocument :execrows
DELETE FROM documents WHERE kind=$1 AND id=$2 AND revision=$3;

-- name: SearchResources :many
SELECT d.kind,d.id,d.revision,d.body,d.search_text,d.updated_at FROM documents d
WHERE d.kind='resource' AND NOT EXISTS (
 SELECT 1 FROM unnest(sqlc.arg(tokens)::text[]) token
 WHERE NOT (strpos(d.search_text, token)>0
 OR to_tsvector('russian',d.search_text) @@ plainto_tsquery('russian',token)
 OR (length(token)>3 AND EXISTS (
 SELECT 1 FROM unnest(regexp_split_to_array(d.search_text,'[^[:alnum:]_.:/-]+')) word
 WHERE abs(length(word)-length(token))<=2 AND similarity(token,word)>=0.25)))
);
