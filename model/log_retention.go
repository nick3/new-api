package model

import (
	"context"
	"fmt"
	"sync"
	"time"

	"one-api/common"
	"one-api/logger"
)

const (
	logDetailCleanupInterval  = 6 * time.Hour
	logDetailCleanupBatchSize = 5000
)

var logDetailCleanupOnce sync.Once

func StartLogDetailRetentionCleaner() {
	logDetailCleanupOnce.Do(func() {
		go runLogDetailCleanupLoop()
	})
}

func runLogDetailCleanupLoop() {
	ctx := context.Background()
	pruneExpiredLogDetails(ctx)
	ticker := time.NewTicker(logDetailCleanupInterval)
	defer ticker.Stop()
	for range ticker.C {
		pruneExpiredLogDetails(ctx)
	}
}

func pruneExpiredLogDetails(ctx context.Context) {
	days := common.DetailedLogRetentionDays
	if days <= 0 {
		return
	}

	cutoff := time.Now().AddDate(0, 0, -days).Unix()
	var totalDeleted int64

	for {
		result := LOG_DB.Where("created_at < ?", cutoff).Limit(logDetailCleanupBatchSize).Delete(&LogDetail{})
		if result.Error != nil {
			logger.LogError(ctx, fmt.Sprintf("failed to prune log detail records: %s", result.Error.Error()))
			break
		}
		if result.RowsAffected == 0 {
			break
		}
		totalDeleted += result.RowsAffected
		if result.RowsAffected < logDetailCleanupBatchSize {
			break
		}
	}

	if totalDeleted > 0 {
		logger.LogInfo(ctx, fmt.Sprintf("pruned %d log detail records older than %d days", totalDeleted, days))
	}
}
