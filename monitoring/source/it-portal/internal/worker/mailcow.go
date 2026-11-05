package worker

import (
	"context"
	"time"

	"pl/portal/internal/model"
	"pl/portal/internal/providers"
)

func (w *Worker) scheduleMailcow(ctx context.Context, source model.Integration) {
	if !source.Enabled || source.Kind != "mailcow" || source.ManagedModuleID == "" {
		return
	}
	anyEnabled := false
	for _, value := range model.MailcowGroupConfig(source.Config) {
		anyEnabled = anyEnabled || value.Enabled
	}
	if !anyEnabled {
		return
	}
	release, ok := w.acquirePoll(ctx, source.ID, false)
	if !ok {
		return
	}
	w.pollWG.Add(1)
	go func() {
		defer w.pollWG.Done()
		defer release()
		for _, group := range model.MailcowGroups() {
			if ctx.Err() != nil {
				return
			}
			snapshot, err := w.Store.MailcowSnapshot(ctx, source.ManagedModuleID)
			if err != nil || !snapshot.Enabled || snapshot.Revision != source.Revision {
				return
			}
			value := snapshot.Groups[group]
			if !value.Enabled || value.LastAttempt != nil && time.Since(*value.LastAttempt) < time.Duration(value.IntervalSeconds)*time.Second {
				continue
			}
			started := time.Now().UTC()
			data, err := w.Providers.MailcowCollect(ctx, source, group)
			if ctx.Err() != nil {
				return
			}
			persist, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = w.Store.ApplyMailcowGroup(persist, source, group, data, providers.MailcowErrorCode(err), started)
			cancel()
			if err != nil {
				return
			}
			if w.Notify != nil {
				w.Notify("mailcow")
			}
		}
	}()
}
