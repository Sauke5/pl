package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"pl/portal/internal/model"
)

// QueueModule atomically commits desired state and the durable operation. The
// request fingerprint excludes generated IDs so retried creations reuse both IDs.
func (s *Store) QueueModule(ctx context.Context, actor, key, id, action string, input model.ModuleRequest) (model.ModuleInstance, model.Job, error) {
	return s.QueueModuleWithCredential(ctx, actor, key, id, action, input, nil)
}

func (s *Store) QueueModuleWithCredential(ctx context.Context, actor, key, id, action string, input model.ModuleRequest, credential *ModuleCredential) (model.ModuleInstance, model.Job, error) {
	var instance model.ModuleInstance
	var job model.Job
	credentialFingerprint := ""
	if credential != nil {
		decoded, err := hex.DecodeString(credential.Fingerprint)
		if err != nil || len(decoded) != 32 || credential.Seal == nil || credential.Origin != input.Endpoint || id != "" || action != "install" || (input.ModuleID != "mailcow" && input.ModuleID != "netmap") || input.Mode != "external" || input.SecretRef != "" {
			return instance, job, ErrInvalid
		}
		credentialFingerprint = credential.Fingerprint
	}
	if id == "" && input.ModuleID == "netmap" && input.Mode == "external" && credential == nil {
		return instance, job, ErrInvalid
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return instance, job, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); err != nil {
		return instance, job, err
	}
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", actor+":"+key); err != nil {
		return instance, job, err
	}
	sum := sha256.Sum256(encode(struct {
		ID, Action string
		Input      model.ModuleRequest
		Credential string `json:",omitempty"`
	}{id, action, input, credentialFingerprint}))
	fp := hex.EncodeToString(sum[:])
	var body []byte
	var oldFP string
	err = tx.QueryRow(ctx, "SELECT body,fingerprint FROM jobs WHERE actor=$1 AND idempotency_key=$2", actor, key).Scan(&body, &oldFP)
	if err == nil {
		if oldFP != fp {
			return instance, job, ErrConflict
		}
		job, err = Decode[model.Job](body)
		if err != nil {
			return instance, job, err
		}
		instanceID, _ := job.Parameters["instance_id"].(string)
		err = tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind IN ('module_instance','module_tombstone') AND id=$1", instanceID).Scan(&body)
		if err == nil {
			instance, err = Decode[model.ModuleInstance](body)
		}
		return instance, job, translate(err)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return instance, job, err
	}
	if id == "" {
		if !model.ModuleModeSupported(input.ModuleID, input.Mode) {
			return instance, job, ErrInvalid
		}
		if action != "install" {
			return instance, job, ErrInvalid
		}
		if input.ModuleID == "bookstack" || input.ModuleID == "netmap" {
			// The public alias is shared by local and external modes. A
			// disabled or removing connection still owns it until deletion commits.
			var existing string
			e := tx.QueryRow(ctx, "SELECT id FROM documents WHERE kind='module_instance' AND body->>'module_id'=$1 ORDER BY id LIMIT 1", input.ModuleID).Scan(&existing)
			if e == nil {
				return instance, job, &ModuleExistsError{InstanceID: existing}
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return instance, job, e
			}
			var occupied bool
			if e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM documents WHERE kind='integration' AND body->>'kind'=$1 AND body->>'enabled'='true')", input.ModuleID).Scan(&occupied); e != nil {
				return instance, job, e
			}
			if occupied || input.AdditionalInstance {
				return instance, job, ErrConflict
			}
		} else if !input.AdditionalInstance {
			var existing string
			e := tx.QueryRow(ctx, "SELECT id FROM documents WHERE kind='module_instance' AND body->>'module_id'=$1 AND body->>'mode'=$2 ORDER BY id LIMIT 1", input.ModuleID, input.Mode).Scan(&existing)
			if e == nil {
				return instance, job, &ModuleExistsError{InstanceID: existing}
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return instance, job, e
			}
		}
		id = uuid.NewString()
		instance = model.ModuleInstance{ID: id, ModuleID: input.ModuleID, Name: input.Name, Mode: input.Mode, Endpoint: input.Endpoint, DesiredState: "enabled", ObservedState: "pending"}
	} else {
		if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "module:"+id); err != nil {
			return instance, job, err
		}
		err = tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='module_instance' AND id=$1 FOR UPDATE", id).Scan(&body)
		if errors.Is(err, pgx.ErrNoRows) && action == "remove" {
			e := tx.QueryRow(ctx, "SELECT body FROM documents WHERE kind='module_tombstone' AND id=$1", id).Scan(&body)
			if e != nil {
				return instance, job, translate(e)
			}
			instance, e = Decode[model.ModuleInstance](body)
			if e != nil {
				return instance, job, e
			}
			if input.ConfirmName != instance.Name {
				return instance, job, ErrInvalid
			}
			now := time.Now().UTC()
			job = model.Job{ID: uuid.NewString(), Kind: "module", Actor: actor, IdempotencyKey: key, Status: "succeeded", CreatedAt: now, FinishedAt: &now, Parameters: map[string]any{"instance_id": id, "action": "remove"}, Result: map[string]any{"instance": instance, "already_removed": true}}
			_, e = tx.Exec(ctx, "INSERT INTO jobs(id,idempotency_key,actor,fingerprint,kind,target,status,body) VALUES($1,$2,$3,$4,'module',$5,'succeeded',$6)", job.ID, key, actor, fp, id, encode(job))
			if e != nil {
				return instance, job, translate(e)
			}
			if e = record(ctx, tx, "module.already_removed", "Удаление модуля уже завершено", instance.ResourceID, actor, map[string]any{"job_id": job.ID, "instance_id": id}, true); e != nil {
				return instance, job, e
			}
			return instance, job, tx.Commit(ctx)
		}
		if err != nil {
			return instance, job, translate(err)
		}
		instance, err = Decode[model.ModuleInstance](body)
		if err != nil {
			return instance, job, err
		}
		var busy bool
		err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM jobs WHERE kind='module' AND target=$1 AND status IN ('queued','running'))", id).Scan(&busy)
		if err != nil {
			return instance, job, err
		}
		if busy {
			return instance, job, ErrConflict
		}
		if instance.DesiredState == "removed" && action != "remove" {
			return instance, job, ErrConflict
		}
		switch action {
		case "reconnect":
			if instance.ModuleID != "bookstack" || instance.Mode != "external" || input.ConnectionRevision < 1 || input.ConnectionRevision != instance.Revision || input.Endpoint == "" {
				return instance, job, ErrConflict
			}
			instance.Endpoint = input.Endpoint
			instance.DesiredState = "enabled"
		case "remove":
			if input.ConfirmName != instance.Name {
				return instance, job, ErrInvalid
			}
			instance.DesiredState = "removed"
		case "enable":
			if instance.ModuleID == "netmap" {
				var occupied bool
				if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM documents WHERE (kind='module_instance' AND body->>'module_id'='netmap' AND id<>$1) OR (kind='integration' AND body->>'kind'='netmap' AND body->>'enabled'='true' AND id<>$2))", instance.ID, instance.IntegrationID).Scan(&occupied); err != nil {
					return instance, job, err
				}
				if occupied {
					return instance, job, ErrConflict
				}
			}
			instance.DesiredState = "enabled"
		case "disable":
			instance.DesiredState = "disabled"
		case "refresh":
		case "configure":
			if instance.ConfigurationError != "" && !instance.ConfigurationRolledBack && instance.ConfigurationLastJobID != "" {
				return instance, job, ErrConflict
			}
			validDraft := instance.ModuleID == "prometheus" && instance.PrometheusDraft != nil && instance.PrometheusDraft.Revision == input.ConfigurationRevision
			if instance.ModuleID == "xray" {
				validDraft = instance.XrayDraft != nil && instance.XrayDraft.Revision == input.ConfigurationRevision && instance.XrayDraft.Ref != ""
			}
			if instance.ModuleID == "alertmanager" {
				validDraft = instance.AlertmanagerDraft != nil && instance.AlertmanagerDraft.Revision == input.ConfigurationRevision && instance.AlertmanagerDraft.Ref != ""
			}
			if instance.ModuleID == "sftpgo" {
				validDraft = instance.SFTPGoDraft != nil && instance.SFTPGoDraft.Revision == input.ConfigurationRevision && instance.SFTPGoDraft.Ref != "" && input.Config["configuration_ref"] == instance.SFTPGoDraft.Ref
			}
			if instance.Mode != "local" || instance.DesiredState != "enabled" || !validDraft || input.ConfigurationRevision < 1 {
				return instance, job, ErrConflict
			}
		default:
			return instance, job, ErrInvalid
		}
		// A refresh observes the current service; queueing it does not change
		// availability. Keep the last observation until the result is committed.
		if action != "refresh" {
			instance.ObservedState = "pending"
		}
		if instance.DesiredState == "removed" {
			instance.ObservedState = "removing"
		}
	}
	now := time.Now().UTC()
	job = model.Job{ID: uuid.NewString(), Kind: "module", Actor: actor, IdempotencyKey: key, Status: "queued", CreatedAt: now, Parameters: map[string]any{"instance_id": id, "action": action}, Result: map[string]any{}}
	if action == "configure" {
		if instance.ModuleID == "xray" {
			job.Parameters["configuration_ref"] = instance.XrayDraft.Ref
			job.Parameters["configuration_revision"] = instance.XrayDraft.Revision
		} else if instance.ModuleID == "alertmanager" {
			job.Parameters["configuration_ref"] = instance.AlertmanagerDraft.Ref
			job.Parameters["configuration_revision"] = instance.AlertmanagerDraft.Revision
		} else if instance.ModuleID == "sftpgo" {
			job.Parameters["configuration_ref"] = instance.SFTPGoDraft.Ref
			job.Parameters["configuration_revision"] = instance.SFTPGoDraft.Revision
			job.Parameters["configuration_request_hash"] = input.Config["request_hash"]
		} else {
			job.Parameters["configuration"] = instance.PrometheusDraft
		}
		instance.ConfigurationLastJobID = job.ID
		instance.ConfigurationError = ""
		instance.ConfigurationRolledBack = false
	}
	instance.LastJobID = job.ID
	if action != "refresh" {
		instance.Error = ""
	}
	if err = syncModuleLinks(ctx, tx, &instance); err != nil {
		return instance, job, err
	}
	if (action == "install" && (instance.ModuleID == "wayline" || instance.ModuleID == "fileauditor" || instance.ModuleID == "mailcow" || instance.ModuleID == "netmap" && instance.Mode == "external")) || ((action == "install" || action == "reconnect") && instance.ModuleID == "bookstack" && instance.Mode == "external") {
		var raw []byte
		if err = tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='integration' AND id=$1 FOR UPDATE", instance.IntegrationID).Scan(&raw); err != nil {
			return instance, job, err
		}
		integration, e := Decode[model.Integration](raw)
		if e != nil {
			return instance, job, e
		}
		integration.SecretRef = input.SecretRef
		if credential != nil {
			envelope, err := credential.Seal(instance.IntegrationID)
			if err != nil {
				return instance, job, ErrInvalid
			}
			if err = putIntegrationCredential(ctx, tx, IntegrationCredential{IntegrationID: instance.IntegrationID, Origin: credential.Origin, ApprovedIPs: credential.ApprovedIPs, Envelope: envelope}); err != nil {
				return instance, job, err
			}
			integration.SecretRef = "managed:" + instance.IntegrationID
		}
		integration.Config = input.Config
		if integration.Config == nil {
			integration.Config = map[string]string{}
		}
		if instance.ModuleID == "wayline" {
			integration.Config["public_url"] = "/wayline/"
			integration.Config["module_mode"] = instance.Mode
		}
		if instance.ModuleID == "mailcow" {
			integration.Config["module_mode"] = "external"
			integration.TimeoutSeconds = 10
		}
		if instance.ModuleID == "netmap" {
			config := make(map[string]string, len(integration.Config)+3)
			for key, value := range integration.Config {
				config[key] = value
			}
			integration.Config = config
			integration.Config["managed"] = "true"
			integration.Config["module_mode"] = "external"
			integration.Config["public_url"] = "/netmap/"
		}
		if instance.ModuleID == "bookstack" {
			config := make(map[string]string, len(integration.Config)+3)
			for key, value := range integration.Config {
				config[key] = value
			}
			integration.Config = config
			integration.Config["managed"] = "true"
			integration.Config["module_mode"] = "external"
			integration.Config["public_url"] = "/wiki/"
		}
		if _, err = save(ctx, tx, "integration", integration.ID, integration.Revision, integration); err != nil {
			return instance, job, err
		}
	}
	saved, err := save(ctx, tx, "module_instance", id, instance.Revision, instance)
	if err != nil {
		return instance, job, err
	}
	instance, err = Decode[model.ModuleInstance](saved)
	if err != nil {
		return instance, job, err
	}
	_, err = tx.Exec(ctx, "INSERT INTO jobs(id,idempotency_key,actor,fingerprint,kind,target,status,body) VALUES($1,$2,$3,$4,'module',$5,'queued',$6)", job.ID, key, actor, fp, id, encode(job))
	if err != nil {
		return instance, job, translate(err)
	}
	details, err := jobEventContext(ctx, tx, job)
	if err != nil {
		return instance, job, err
	}
	if err = record(ctx, tx, "module.queued", jobEventTitle(job, details), "", actor, details, true); err != nil {
		return instance, job, err
	}
	return instance, job, tx.Commit(ctx)
}

func finishModule(ctx context.Context, tx pgx.Tx, j model.Job) error {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7398218)"); err != nil {
		return err
	}
	id, _ := j.Parameters["instance_id"].(string)
	var body []byte
	err := tx.QueryRow(ctx, "SELECT body || jsonb_build_object('id',id,'revision',revision) FROM documents WHERE kind='module_instance' AND id=$1 FOR UPDATE", id).Scan(&body)
	if err != nil {
		return translate(err)
	}
	previous, err := Decode[model.ModuleInstance](body)
	if err != nil {
		return err
	}
	if previous.LastJobID != j.ID {
		return ErrConflict
	}
	instance := previous
	if raw, ok := j.Result["instance"]; ok {
		instance, err = Decode[model.ModuleInstance](encode(raw))
		if err != nil {
			return err
		}
		if instance.ID != id || instance.LastJobID != j.ID {
			return ErrInvalid
		}
	} else {
		// Even shutdown or a read timeout before Execute loaded the document must
		// release the pending display state when the job is durably finished.
		now := time.Now().UTC()
		instance.LastAttempt = &now
		instance.ObservedState = "unavailable"
		instance.Error = "Операция прервана до подтверждения состояния; выполните проверку."
	}
	if j.Parameters["action"] == "configure" && j.Status != "succeeded" && instance.ConfigurationError == "" {
		instance.ConfigurationError = j.Error
		if instance.ConfigurationError == "" {
			instance.ConfigurationError = "Результат применения конфигурации не подтверждён"
		}
	}
	if instance.IntegrationID != previous.IntegrationID || instance.ResourceID != previous.ResourceID {
		return ErrInvalid
	}
	if instance.DesiredState == "removed" && instance.ObservedState == "absent" && j.Status == "succeeded" {
		return deleteModule(ctx, tx, instance, j.Actor)
	}
	if err = syncModuleLinks(ctx, tx, &instance); err != nil {
		return err
	}
	_, err = save(ctx, tx, "module_instance", id, previous.Revision, instance)
	return err
}

// ModuleActorAdmin rechecks durable role state immediately before lifecycle work.
// A browser session checked when enqueuing cannot authorize work after demotion.
func (s *Store) ModuleActorAdmin(ctx context.Context, actor string) (bool, error) {
	if actor == "local-admin" {
		return true, nil
	}
	var allowed bool
	var err error
	if strings.HasPrefix(actor, "local:") {
		err = s.Pool.QueryRow(ctx, "SELECT admin AND NOT disabled FROM local_users WHERE id=$1", actor).Scan(&allowed)
	} else {
		err = s.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM sessions WHERE user_id=$1 AND admin AND expires_at>now())", actor).Scan(&allowed)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return allowed, err
}
