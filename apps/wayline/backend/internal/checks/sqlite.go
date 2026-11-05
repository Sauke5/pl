package checks

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

var ErrNotFound = errors.New("проверка не найдена")

type Repository interface {
	Save(context.Context, Run) (Run, error)
	List(context.Context, *int64, *string, int) ([]Run, error)
	Latest(context.Context, *string) ([]Run, error)
	Get(context.Context, int64) (Run, error)
	LastFinishedAt(context.Context, int64, string) (*time.Time, error)
	CleanupBefore(context.Context, time.Time) (int64, error)
	Metrics(context.Context) (Metrics, error)
}

func (r *SQLiteRepository) Latest(ctx context.Context, kind *string) ([]Run, error) {
	query := selectRunsAliased + ` JOIN targets t ON t.id = cr.target_id `
	args := make([]any, 0, 1)
	if kind != nil {
		query += `WHERE cr.id = (
			SELECT latest.id FROM check_runs latest
			WHERE latest.target_id = t.id AND latest.kind = ?
			ORDER BY latest.finished_at DESC, latest.id DESC LIMIT 1
		) `
		args = append(args, *kind)
	} else {
		query += `JOIN (SELECT 'path' AS kind UNION ALL SELECT 'iperf') kinds ON cr.kind = kinds.kind
		WHERE cr.id = (
			SELECT latest.id FROM check_runs latest
			WHERE latest.target_id = t.id AND latest.kind = kinds.kind
			ORDER BY latest.finished_at DESC, latest.id DESC LIMIT 1
		) `
	}
	query += "ORDER BY cr.target_id, cr.kind"
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("получить последние проверки целей: %w", err)
	}
	defer rows.Close()
	items := make([]Run, 0)
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, run)
	}
	return items, rows.Err()
}

type SQLiteRepository struct{ db *sql.DB }

func NewSQLiteRepository(db *sql.DB) *SQLiteRepository { return &SQLiteRepository{db: db} }

func (r *SQLiteRepository) Save(ctx context.Context, run Run) (Run, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return Run{}, fmt.Errorf("начать сохранение проверки: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `INSERT INTO check_runs (
		target_id, kind, direction, execution_type, execution_id, status, started_at, finished_at, duration_ms,
		loss_percent, avg_latency_ms, jitter_ms, throughput_bps, error_message
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.TargetID, run.Kind, run.Direction, run.ExecutionType, run.ExecutionID, run.Status, formatTime(run.StartedAt), formatTime(run.FinishedAt),
		run.DurationMS, run.LossPercent, run.AvgLatencyMS, run.JitterMS, run.ThroughputBPS, run.ErrorMessage)
	if err != nil {
		return Run{}, fmt.Errorf("сохранить проверку: %w", err)
	}
	run.ID, err = result.LastInsertId()
	if err != nil {
		return Run{}, fmt.Errorf("получить идентификатор проверки: %w", err)
	}
	for _, hop := range run.Hops {
		_, err = tx.ExecContext(ctx, `INSERT INTO hop_results (
            check_run_id, hop_number, host, ip, loss_percent, packets_sent,
            last_ms, avg_ms, best_ms, worst_ms, stddev_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, run.ID, hop.HopNumber, hop.Host, hop.IP,
			hop.LossPercent, hop.PacketsSent, hop.LastMS, hop.AvgMS, hop.BestMS, hop.WorstMS, hop.StdDevMS)
		if err != nil {
			return Run{}, fmt.Errorf("сохранить узел маршрута: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return Run{}, fmt.Errorf("завершить сохранение проверки: %w", err)
	}
	if run.Hops == nil {
		run.Hops = []Hop{}
	}
	return run, nil
}

func (r *SQLiteRepository) List(ctx context.Context, targetID *int64, kind *string, limit int) ([]Run, error) {
	query := selectRuns
	args := make([]any, 0, 3)
	conditions := make([]string, 0, 2)
	if targetID != nil {
		conditions = append(conditions, "target_id = ?")
		args = append(args, *targetID)
	}
	if kind != nil {
		conditions = append(conditions, "kind = ?")
		args = append(args, *kind)
	}
	if len(conditions) > 0 {
		query += " WHERE " + strings.Join(conditions, " AND ")
	}
	query += " ORDER BY started_at DESC, id DESC LIMIT ?"
	args = append(args, limit)
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("получить историю проверок: %w", err)
	}
	defer rows.Close()
	items := make([]Run, 0)
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, run)
	}
	return items, rows.Err()
}

func (r *SQLiteRepository) Get(ctx context.Context, id int64) (Run, error) {
	run, err := scanRun(r.db.QueryRowContext(ctx, selectRuns+" WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	if err != nil {
		return Run{}, err
	}
	rows, err := r.db.QueryContext(ctx, `SELECT hop_number, host, ip, loss_percent, packets_sent,
        last_ms, avg_ms, best_ms, worst_ms, stddev_ms
        FROM hop_results WHERE check_run_id = ? ORDER BY hop_number`, id)
	if err != nil {
		return Run{}, fmt.Errorf("получить маршрут проверки: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var hop Hop
		if err := rows.Scan(&hop.HopNumber, &hop.Host, &hop.IP, &hop.LossPercent, &hop.PacketsSent,
			&hop.LastMS, &hop.AvgMS, &hop.BestMS, &hop.WorstMS, &hop.StdDevMS); err != nil {
			return Run{}, fmt.Errorf("прочитать узел маршрута: %w", err)
		}
		run.Hops = append(run.Hops, hop)
	}
	if run.Hops == nil {
		run.Hops = []Hop{}
	}
	return run, rows.Err()
}

func (r *SQLiteRepository) LastFinishedAt(ctx context.Context, targetID int64, kind string) (*time.Time, error) {
	var value string
	err := r.db.QueryRowContext(ctx, `SELECT finished_at FROM check_runs
		WHERE target_id = ? AND kind = ? ORDER BY finished_at DESC, id DESC LIMIT 1`, targetID, kind).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("получить время последней проверки: %w", err)
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil, fmt.Errorf("прочитать время последней проверки: %w", err)
	}
	return &parsed, nil
}

func (r *SQLiteRepository) CleanupBefore(ctx context.Context, cutoff time.Time) (int64, error) {
	result, err := r.db.ExecContext(ctx, `DELETE FROM check_runs WHERE finished_at < ?`, formatTime(cutoff))
	if err != nil {
		return 0, fmt.Errorf("удалить устаревшую историю проверок: %w", err)
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("получить число удалённых проверок: %w", err)
	}
	return deleted, nil
}

func (r *SQLiteRepository) Metrics(ctx context.Context) (Metrics, error) {
	var metrics Metrics
	rows, err := r.db.QueryContext(ctx, `SELECT kind, status, COUNT(*) FROM check_runs GROUP BY kind, status`)
	if err != nil {
		return metrics, fmt.Errorf("получить счётчики проверок: %w", err)
	}
	for rows.Next() {
		var item MetricCount
		if err := rows.Scan(&item.Kind, &item.Status, &item.Count); err != nil {
			_ = rows.Close()
			return metrics, err
		}
		metrics.Counts = append(metrics.Counts, item)
	}
	if err := rows.Close(); err != nil {
		return metrics, err
	}
	rows, err = r.db.QueryContext(ctx, `SELECT t.id, t.name, COALESCE((
		SELECT cr.status FROM check_runs cr WHERE cr.target_id = t.id AND cr.kind = 'path'
		ORDER BY cr.started_at DESC, cr.id DESC LIMIT 1
    ), '') FROM targets t ORDER BY t.id`)
	if err != nil {
		return metrics, fmt.Errorf("получить последние статусы целей: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var item LatestStatus
		if err := rows.Scan(&item.TargetID, &item.Name, &item.Status); err != nil {
			return metrics, err
		}
		metrics.Latest = append(metrics.Latest, item)
	}
	return metrics, rows.Err()
}

const selectRuns = `SELECT id, target_id, kind, direction, execution_type, execution_id, status, started_at, finished_at,
	duration_ms, loss_percent, avg_latency_ms, jitter_ms, throughput_bps, error_message
	FROM check_runs`

const selectRunsAliased = `SELECT cr.id, cr.target_id, cr.kind, cr.direction, cr.execution_type, cr.execution_id, cr.status,
	cr.started_at, cr.finished_at, cr.duration_ms, cr.loss_percent, cr.avg_latency_ms, cr.jitter_ms,
	cr.throughput_bps, cr.error_message FROM check_runs cr`

type scanner interface{ Scan(...any) error }

func scanRun(row scanner) (Run, error) {
	var run Run
	var started, finished string
	if err := row.Scan(&run.ID, &run.TargetID, &run.Kind, &run.Direction, &run.ExecutionType, &run.ExecutionID, &run.Status, &started, &finished,
		&run.DurationMS, &run.LossPercent, &run.AvgLatencyMS, &run.JitterMS, &run.ThroughputBPS,
		&run.ErrorMessage); err != nil {
		return Run{}, err
	}
	var err error
	run.StartedAt, err = time.Parse(time.RFC3339Nano, started)
	if err != nil {
		return Run{}, fmt.Errorf("прочитать начало проверки: %w", err)
	}
	run.FinishedAt, err = time.Parse(time.RFC3339Nano, finished)
	if err != nil {
		return Run{}, fmt.Errorf("прочитать завершение проверки: %w", err)
	}
	run.Hops = []Hop{}
	return run, nil
}

func formatTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }
