package store

import (
	"context"
	"io"
	"time"
)

const (
	LogExportMaxRows  = 5000
	LogExportMaxBytes = 1 << 20
)

// ExportLog selects the newest records in the requested window. The projection
// uses only diagnostic metadata. Raw job output, audit diffs, and resource or
// connector configuration can contain credentials or arbitrary user content.
func (s *Store) ExportLog(ctx context.Context, channel string, since, until time.Time, dst io.Writer) (count int, truncated bool, err error) {
	var query string
	switch channel {
	case "events", "audit":
		table, err := journalTable(channel)
		if err != nil {
			return 0, false, err
		}
		query = `SELECT jsonb_strip_nulls(jsonb_build_object(
		  'id',left(id,160), 'kind',left(body->>'kind',96),
		  'occurred_at',occurred_at, 'recorded_at',created_at,
		  'actor_id',left(nullif(body->>'actor',''),192), 'resource_id',left(nullif(body->>'resource_id',''),160),
		  'source_kind',left(body#>>'{details,source_kind}',96), 'integration_id',left(body#>>'{details,integration_id}',160),
		  'observation_id',left(body#>>'{details,observation_id}',160), 'problem_id',left(body#>>'{details,problem_id}',160),
		  'object_kind',left(body#>>'{details,object_kind}',96), 'object_id',left(body#>>'{details,object_id}',160),
		  'job_id',left(body#>>'{details,job_id}',160), 'status',left(body#>>'{details,status}',32),
		  'request_id',left(body#>>'{details,request_id}',32)))::text
		FROM ` + table + ` WHERE occurred_at BETWEEN $1 AND $2 ORDER BY occurred_at DESC,id DESC LIMIT $3`
	case "operations":
		query = `SELECT jsonb_strip_nulls(jsonb_build_object(
		  'id',left(id,160), 'kind',left(kind,96), 'status',status, 'actor_id',left(actor,192),
		  'resource_id',left(nullif(body->>'resource_id',''),160), 'integration_id',left(nullif(body->>'integration_id',''),160),
		  'module_id',left(body#>>'{parameters,module_id}',64), 'instance_id',left(body#>>'{parameters,instance_id}',160),
		  'action',left(body#>>'{parameters,action}',64), 'check_kind',left(body#>>'{parameters,kind}',64),
		  'created_at',created_at, 'started_at',started_at, 'finished_at',finished_at))::text
		FROM jobs WHERE created_at BETWEEN $1 AND $2 OR started_at BETWEEN $1 AND $2 OR finished_at BETWEEN $1 AND $2
		ORDER BY greatest(created_at,started_at,finished_at) DESC,id DESC LIMIT $3`
	default:
		return 0, false, ErrInvalid
	}
	rows, err := s.Pool.Query(ctx, query, since, until, LogExportMaxRows+1)
	if err != nil {
		return 0, false, err
	}
	defer rows.Close()
	size := 0
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return count, false, err
		}
		if count >= LogExportMaxRows || size+len(line)+1 > LogExportMaxBytes {
			return count, true, nil
		}
		n, err := io.WriteString(dst, line+"\n")
		if err != nil {
			return count, false, err
		}
		if n != len(line)+1 {
			return count, false, io.ErrShortWrite
		}
		size += n
		count++
	}
	return count, false, rows.Err()
}
