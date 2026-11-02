package model

import (
	"context"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/logger"
	"gorm.io/gorm/clause"
)

const (
	logDetailCleanupInterval  = 6 * time.Hour
	logDetailCleanupBatchSize = 100
	logCleanupBatchTimeout    = 10 * time.Second
	logCleanupBatchDelay      = 100 * time.Millisecond
	logDetailCleanupTimeout   = 5 * time.Minute
	logDetailCleanupLockType  = "log_detail_retention"
)

var logDetailCleanupOnce sync.Once

func StartLogDetailRetentionCleaner() {
	if !common.IsMasterNode {
		return
	}
	logDetailCleanupOnce.Do(func() {
		go runLogDetailCleanupLoop(context.Background())
	})
}

func runLogDetailCleanupLoop(ctx context.Context) {
	// Keep large retention work off the startup path and stagger master nodes.
	timer := time.NewTimer(time.Minute + time.Duration(rand.IntN(240))*time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
	}
	pruneExpiredLogDetails(ctx)
	ticker := time.NewTicker(logDetailCleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pruneExpiredLogDetails(ctx)
		}
	}
}

func pruneExpiredLogDetails(parent context.Context) {
	if common.UsingLogDatabase(common.DatabaseTypeClickHouse) {
		return
	}
	days := common.DetailedLogRetentionDays
	if days <= 0 {
		return
	}
	ctx, cancel := context.WithTimeout(parent, logDetailCleanupTimeout)
	defer cancel()
	owner, err := GenerateSystemTaskID()
	if err != nil {
		logger.LogError(ctx, common.LogText("failed to create log detail cleanup lease owner: %s", err.Error()))
		return
	}
	acquired, err := acquireLogDetailCleanupLease(ctx, owner)
	if err != nil {
		logger.LogError(ctx, common.LogText("failed to acquire log detail cleanup lease: %s", err.Error()))
		return
	}
	if !acquired {
		return
	}
	defer func() {
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), logCleanupBatchTimeout)
		defer releaseCancel()
		if err := DB.WithContext(releaseCtx).
			Where("type = ? AND task_id = ?", logDetailCleanupLockType, owner).
			Delete(&SystemTaskLock{}).Error; err != nil {
			logger.LogError(releaseCtx, common.LogText("failed to release log detail cleanup lease: %s", err.Error()))
		}
	}()

	cutoff := time.Now().AddDate(0, 0, -days).Unix()
	var totalDeleted int64
	for {
		deleted, err := deleteExpiredLogDetailBatch(ctx, cutoff, logDetailCleanupBatchSize)
		if err != nil {
			logger.LogError(ctx, common.LogText("failed to prune log detail records: %s", err.Error()))
			break
		}
		totalDeleted += deleted
		if deleted < logDetailCleanupBatchSize {
			break
		}
		if err := WaitLogCleanupBatch(ctx); err != nil {
			break
		}
	}
	if totalDeleted > 0 {
		logger.LogInfo(ctx, common.LogText("pruned %d log detail records older than %d days", totalDeleted, days))
	}
}

func acquireLogDetailCleanupLease(ctx context.Context, owner string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, logCleanupBatchTimeout)
	defer cancel()
	now := time.Now().Unix()
	// The lease outlives the bounded pass; no other master may take it while
	// that pass is running. Reuse the existing primary-database lease table.
	lock := &SystemTaskLock{
		Type: logDetailCleanupLockType, TaskID: owner, LockedBy: owner,
		LockedUntil: now + int64((logDetailCleanupTimeout+time.Minute)/time.Second),
		UpdatedAt:   now,
	}
	db := DB.WithContext(ctx)
	if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(lock).Error; err != nil {
		return false, err
	}
	if err := db.Model(&SystemTaskLock{}).
		Where("type = ? AND locked_until < ?", logDetailCleanupLockType, now).
		Updates(map[string]any{
			"task_id": owner, "locked_by": owner,
			"locked_until": lock.LockedUntil, "updated_at": now,
		}).Error; err != nil {
		return false, err
	}
	// Do not infer ownership from upsert RowsAffected: MySQL's found-rows
	// setting can report a matched row even when the conflicting lease won.
	var held SystemTaskLock
	if err := db.Where("type = ?", logDetailCleanupLockType).Take(&held).Error; err != nil {
		return false, err
	}
	return held.TaskID == owner, nil
}

func deleteExpiredLogDetailBatch(ctx context.Context, cutoff int64, limit int) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, logCleanupBatchTimeout)
	defer cancel()
	if limit <= 0 {
		limit = logDetailCleanupBatchSize
	}
	limit = min(limit, 1000)
	var ids []int
	if err := LOG_DB.WithContext(ctx).Model(&LogDetail{}).
		Where("created_at < ?", cutoff).Order("created_at ASC, log_id ASC").
		Limit(limit).Pluck("log_id", &ids).Error; err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}
	result := LOG_DB.WithContext(ctx).
		Where("log_id IN ? AND created_at < ?", ids, cutoff).Delete(&LogDetail{})
	return result.RowsAffected, result.Error
}

// WaitLogCleanupBatch throttles manual and automatic cleanup alike.
func WaitLogCleanupBatch(ctx context.Context) error {
	timer := time.NewTimer(logCleanupBatchDelay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
