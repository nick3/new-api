package model

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

func TestLogDetailMigrationAndScopedMetadata(t *testing.T) {
	for _, separate := range []bool{false, true} {
		name := "shared"
		if separate {
			name = "separate"
		}
		t.Run(name, func(t *testing.T) {
			previousDB, previousLogDB := DB, LOG_DB
			previousMainType, previousLogType := common.MainDatabaseType(), common.LogDatabaseType()
			previousPath, previousMaster := common.SQLitePath, common.IsMasterNode
			previousConsume, previousExport := common.LogConsumeEnabled, common.DataExportEnabled
			previousRetention := common.DetailedLogRetentionDays
			t.Cleanup(func() {
				DB, LOG_DB = previousDB, previousLogDB
				common.SetMainDatabaseType(previousMainType)
				common.SetLogDatabaseType(previousLogType)
				common.SQLitePath, common.IsMasterNode = previousPath, previousMaster
				common.LogConsumeEnabled, common.DataExportEnabled = previousConsume, previousExport
				common.DetailedLogRetentionDays = previousRetention
				initCol()
			})
			common.SQLitePath = filepath.Join(t.TempDir(), "main.db")
			mainDSN := os.Getenv("MERGE_TEST_MAIN_DSN")
			if mainDSN == "" {
				mainDSN = "local"
			}
			t.Setenv("MERGE_TEST_SQL_DSN", mainDSN)
			var err error
			var mainType common.DatabaseType
			DB, mainType, err = chooseDB("MERGE_TEST_SQL_DSN", false)
			require.NoError(t, err)
			sqlDB, err := DB.DB()
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
			common.SetMainDatabaseType(mainType)
			common.IsMasterNode = true
			common.LogConsumeEnabled, common.DataExportEnabled = true, false
			t.Setenv("LOG_SQL_DSN", "")
			if separate {
				common.SQLitePath = filepath.Join(t.TempDir(), "logs.db")
				logDSN := "local"
				if mainType != common.DatabaseTypeSQLite {
					logDSN = os.Getenv("MERGE_TEST_LOG_DSN")
					require.NotEmpty(t, logDSN, "external tests require a dedicated log database")
				}
				t.Setenv("LOG_SQL_DSN", logDSN)
			}
			hadMainDetails := DB.Migrator().HasTable(&LogDetail{})
			require.NoError(t, InitLogDB())
			require.NoError(t, DB.AutoMigrate(&SystemTaskLock{}))
			require.NoError(t, DB.Where("type = ?", logDetailCleanupLockType).Delete(&SystemTaskLock{}).Error)
			for _, table := range []any{&Log{}, &LogDetail{}, &AuditLog{}} {
				require.NoError(t, LOG_DB.Where("1 = 1").Delete(table).Error)
			}
			logDB := LOG_DB
			if separate {
				logSQLDB, err := logDB.DB()
				require.NoError(t, err)
				t.Cleanup(func() { require.NoError(t, logSQLDB.Close()) })
				assert.Equal(t, hadMainDetails, DB.Migrator().HasTable(&LogDetail{}), "external log migration must not create tables in the main database")
			}
			var version string
			versionQuery := "SELECT VERSION()"
			if mainType == common.DatabaseTypeSQLite {
				versionQuery = "SELECT sqlite_version()"
			}
			require.NoError(t, logDB.Raw(versionQuery).Scan(&version).Error)
			t.Logf("%s %s, %s log database", mainType, version, name)
			assert.True(t, logDB.Migrator().HasTable(&AuditLog{}))
			assert.True(t, logDB.Migrator().HasIndex(&LogDetail{}, "idx_log_details_created_at"))

			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
			c.Request.RemoteAddr = "192.0.2.1:1234"
			c.Set("username", "merge-test")
			other := NewLogOther()
			require.True(t, other.SetPublic("model_price", 1.25))
			require.True(t, other.SetAdmin("reject_reason", "policy rejection"))
			require.True(t, other.SetRoot("node_name", "private-node"))
			request, response := `{"input":"hello"}`, `{"output":"world"}`
			RecordConsumeLog(c, 42, RecordConsumeLogParams{
				TokenId: 11, Other: other, Quota: 123,
				Content:            []*common.Message{common.NewMessage("Model test")},
				RequestBodyPreview: request, ResponseBodyPreview: response,
			})
			common.CapturePayloadStringForLog(c, constant.ContextKeyLoggedRequestBody, request)
			common.CapturePayloadStringForLog(c, constant.ContextKeyLoggedResponseBody, response)
			errorOther := NewLogOther()
			require.True(t, errorOther.SetPublic("model_price", 1.25))
			require.True(t, errorOther.SetAdmin("reject_reason", "policy rejection"))
			require.True(t, errorOther.SetRoot("node_name", "private-node"))
			RecordErrorLog(c, 42, 1, "test", "", "Request rejected", 11, 1, false, "default", errorOther)
			for range 2 {
				require.NoError(t, migrateLOGDB())
			}
			var stored []*Log
			require.NoError(t, logDB.Order("id").Find(&stored).Error)
			require.Len(t, stored, 2)
			assert.Equal(t, 123, stored[0].Quota)
			assert.Equal(t, "Model test", stored[0].Content)
			assert.Equal(t, "Request rejected", stored[1].Content)
			savedDetails, err := GetLogDetailsByIDs([]int{stored[0].Id, stored[1].Id})
			require.NoError(t, err)
			for _, entry := range stored {
				entry.Detail = savedDetails[entry.Id]
			}
			for _, entry := range stored {
				assert.Equal(t, "192.0.2.1", entry.Ip)
				wantOther := other.JSONString()
				if entry.Type == LogTypeError {
					wantOther = errorOther.JSONString()
				}
				assert.JSONEq(t, wantOther, entry.Other)
				require.NotNil(t, entry.Detail)
				assert.Equal(t, LargeText(request), entry.Detail.RequestBody)
				assert.Equal(t, LargeText(response), entry.Detail.ResponseBody)
			}
			filter := LogFilter{Type: LogTypeConsume}
			allLogs, total, err := GetAllLogs(filter, 0, 10)
			require.NoError(t, err)
			require.EqualValues(t, 1, total)
			require.Len(t, allLogs, 1)
			assert.Nil(t, allLogs[0].Detail)
			assert.True(t, allLogs[0].HasDetail)
			assert.Equal(t, stored[0].Id, allLogs[0].DetailId)
			filteredUserLogs, total, err := GetUserLogs(42, filter, 0, 10)
			require.NoError(t, err)
			require.EqualValues(t, 1, total)
			require.Len(t, filteredUserLogs, 1)
			assert.Nil(t, filteredUserLogs[0].Detail)
			assert.True(t, filteredUserLogs[0].HasDetail)
			assert.Equal(t, stored[0].Id, filteredUserLogs[0].DetailId)

			var exported []*Log
			require.NoError(t, StreamUserLogs(context.Background(), 42, filter, func(log *Log) error {
				exported = append(exported, log)
				return nil
			}))
			require.Len(t, exported, 1)
			assert.JSONEq(t, filteredUserLogs[0].Other, exported[0].Other)
			assert.Equal(t, 1, exported[0].Id)
			assert.Empty(t, exported[0].ChannelName)
			assert.Nil(t, exported[0].Detail, "CSV exports do not load request or response bodies")

			userLogs, err := GetLogByTokenId(11)
			require.NoError(t, err)
			require.Len(t, userLogs, 2)
			for _, entry := range userLogs {
				assert.Nil(t, entry.Detail)
				assert.True(t, entry.HasDetail)
				wantOther := `{"model_price":1.25}`
				if entry.Type == LogTypeConsume {
					wantOther = `{"model_price":1.25,"content_parts":[{"key":"Model test"}]}`
				}
				assert.JSONEq(t, wantOther, entry.Other)
			}
			require.Error(t, logDB.Create(stored[0].Detail).Error, "detail primary key must survive repeated migration")
			require.NoError(t, logDB.Create(&AuditLog{EventId: "retained-audit", CreatedAt: 1}).Error)
			require.NoError(t, logDB.Model(&LogDetail{}).Where("log_id = ?", stored[0].Id).
				Update("created_at", time.Now().AddDate(0, 0, -3).Unix()).Error)
			common.DetailedLogRetentionDays = 1
			pruneExpiredLogDetails(context.Background())
			for _, tc := range []struct {
				model any
				count int64
			}{{&Log{}, 2}, {&LogDetail{}, 1}, {&AuditLog{}, 1}} {
				var count int64
				require.NoError(t, logDB.Model(tc.model).Count(&count).Error)
				assert.Equal(t, tc.count, count)
			}
		})
	}
}

func TestResolveLogPayloadsFallsBackToBodyStorageFullText(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())

	body := `{"message":"` + strings.Repeat("a", 9000) + `"}`
	storage, err := common.CreateBodyStorage([]byte(body))
	if err != nil {
		t.Fatalf("CreateBodyStorage failed: %v", err)
	}
	defer storage.Close()

	ctx.Set(common.KeyBodyStorage, storage)
	common.CapturePayloadPreviewForLog(ctx, constant.ContextKeyLoggedRequestBody, []byte(body[:8192]))

	request, response := resolveLogPayloads(ctx, "", "")
	if response != "" {
		t.Fatalf("expected empty response payload, got %q", response)
	}
	if request != body {
		t.Fatalf("expected full request payload, got length=%d want=%d", len(request), len(body))
	}
}

func TestResolveLogPayloadsPrefersCapturedStructuredRequestBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())

	rawBody := `{"input":"original"}`
	transformedBody := `{"messages":[{"role":"user","content":"converted"}]}`

	storage, err := common.CreateBodyStorage([]byte(rawBody))
	if err != nil {
		t.Fatalf("CreateBodyStorage failed: %v", err)
	}
	defer storage.Close()

	ctx.Set(common.KeyBodyStorage, storage)
	common.CapturePayloadStringForLog(ctx, constant.ContextKeyLoggedRequestBody, transformedBody)

	request, _ := resolveLogPayloads(ctx, "", "")
	if request != transformedBody {
		t.Fatalf("expected transformed request payload, got %q", request)
	}
}

func useLogPerformanceDatabase(t testing.TB) {
	t.Helper()
	previousDB, previousLogDB := DB, LOG_DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	previousPath, previousMemory := common.SQLitePath, common.MemoryCacheEnabled
	t.Cleanup(func() {
		DB, LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.SQLitePath, common.MemoryCacheEnabled = previousPath, previousMemory
		initCol()
	})
	common.MemoryCacheEnabled = false
	for i, name := range []string{"LOG_PERF_MAIN_DSN", "LOG_PERF_LOG_DSN"} {
		common.SQLitePath = filepath.Join(t.TempDir(), "logs.db")
		db, typ, err := chooseDB(name, false)
		require.NoError(t, err)
		db = db.Session(&gorm.Session{Logger: db.Logger.LogMode(gormlogger.Silent)})
		sqlDB, err := db.DB()
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
		if i == 0 {
			DB = db
			common.SetMainDatabaseType(typ)
			require.NoError(t, DB.AutoMigrate(&Channel{}, &SystemTaskLock{}))
			require.NoError(t, DB.Where("type = ?", logDetailCleanupLockType).Delete(&SystemTaskLock{}).Error)
			continue
		}
		LOG_DB = db
		common.SetLogDatabaseType(typ)
		require.NoError(t, LOG_DB.AutoMigrate(&Log{}, &LogDetail{}))
		for _, table := range []any{&LogDetail{}, &Log{}} {
			require.NoError(t, LOG_DB.Where("1 = 1").Delete(table).Error)
		}
	}
	mainDB := DB
	t.Cleanup(func() {
		require.NoError(t, mainDB.Where("type = ?", logDetailCleanupLockType).Delete(&SystemTaskLock{}).Error)
	})
	initCol()
}

func TestLogListsDoNotLoadBodies(t *testing.T) {
	useLogPerformanceDatabase(t)
	entry := &Log{UserId: 42, TokenId: 11, CreatedAt: 1, Type: LogTypeConsume}
	require.NoError(t, LOG_DB.Create(entry).Error)
	body := LargeText(strings.Repeat("x", 1<<20))
	require.NoError(t, LOG_DB.Create(&LogDetail{LogId: entry.Id, RequestBody: body, ResponseBody: body}).Error)
	for _, query := range []struct {
		name string
		run  func() ([]*Log, error)
	}{
		{"admin", func() ([]*Log, error) { logs, _, err := GetAllLogs(LogFilter{}, 0, 100); return logs, err }},
		{"user", func() ([]*Log, error) { logs, _, err := GetUserLogs(42, LogFilter{}, 0, 100); return logs, err }},
		{"token", func() ([]*Log, error) { return GetLogByTokenId(11) }},
	} {
		t.Run(query.name, func(t *testing.T) {
			logs, err := query.run()
			require.NoError(t, err)
			require.Len(t, logs, 1)
			assert.True(t, logs[0].Detail == nil, "list must not read saved bodies")
			assert.True(t, logs[0].HasDetail)
			assert.Equal(t, entry.Id, logs[0].DetailId)
			encoded, err := common.Marshal(logs)
			require.NoError(t, err)
			assert.Less(t, len(encoded), 2048, "response size must be independent of body size")
		})
	}
}

func TestDeleteOldLogsRespectsBatchLimit(t *testing.T) {
	useLogPerformanceDatabase(t)
	for i := range 9 {
		require.NoError(t, LOG_DB.Create(&Log{UserId: 42, CreatedAt: int64(i + 1)}).Error)
	}
	deleted, err := DeleteOldLogBatch(context.Background(), 8, 3)
	require.NoError(t, err)
	assert.EqualValues(t, 3, deleted)
	var remaining int64
	require.NoError(t, LOG_DB.Model(&Log{}).Count(&remaining).Error)
	assert.EqualValues(t, 6, remaining)
	for _, want := range []int64{3, 1, 0} {
		deleted, err = DeleteOldLogBatch(context.Background(), 8, 3)
		require.NoError(t, err)
		assert.Equal(t, want, deleted)
	}
	var retained []int64
	require.NoError(t, LOG_DB.Model(&Log{}).Order("created_at").Pluck("created_at", &retained).Error)
	assert.Equal(t, []int64{8, 9}, retained)
}

func BenchmarkLogListPayloads(b *testing.B) {
	useLogPerformanceDatabase(b)
	body := LargeText(strings.Repeat("x", 1<<20))
	for range 100 {
		entry := &Log{UserId: 42, CreatedAt: 1, Type: LogTypeConsume}
		require.NoError(b, LOG_DB.Create(entry).Error)
		require.NoError(b, LOG_DB.Create(&LogDetail{LogId: entry.Id, RequestBody: body}).Error)
	}
	b.ReportAllocs()
	b.ResetTimer()
	var size int
	for range b.N {
		logs, _, err := GetUserLogs(42, LogFilter{}, 0, 100)
		require.NoError(b, err)
		encoded, err := common.Marshal(logs)
		require.NoError(b, err)
		size = len(encoded)
	}
	b.ReportMetric(float64(size), "response-bytes")
}

func TestLogDetailAccessAndExpiry(t *testing.T) {
	useLogPerformanceDatabase(t)
	require.NoError(t, LOG_DB.Create(&Log{UserId: 2, CreatedAt: 1}).Error)
	entries := []Log{
		{UserId: 2, TokenId: 22, CreatedAt: 1},
		{UserId: 1, TokenId: 11, CreatedAt: 2},
		{UserId: 1, TokenId: 12, CreatedAt: 3},
	}
	for i := range entries {
		require.NoError(t, LOG_DB.Create(&entries[i]).Error)
	}
	entry := entries[1]
	require.NoError(t, LOG_DB.Create(&LogDetail{LogId: entry.Id, RequestBody: "complete request", ResponseBody: "complete response"}).Error)
	listed, _, err := GetUserLogs(1, LogFilter{}, 1, 1)
	require.NoError(t, err)
	require.Len(t, listed, 1)
	assert.Equal(t, 2, listed[0].Id)
	assert.Equal(t, entry.Id, listed[0].DetailId)
	assert.NotEqual(t, listed[0].Id, listed[0].DetailId)
	// A different page size still provides the same stable detail identifier.
	listed, _, err = GetUserLogs(1, LogFilter{}, 0, 2)
	require.NoError(t, err)
	assert.Equal(t, entry.Id, listed[1].DetailId)
	for _, tc := range []struct {
		name    string
		scope   LogDetailScope
		allowed bool
	}{
		{"owner", LogDetailScope{UserId: 1}, true},
		{"own token", LogDetailScope{UserId: 1, TokenId: 11}, true},
		{"administrator", LogDetailScope{UserId: 9, Admin: true}, true},
		{"anonymous", LogDetailScope{}, false},
		{"other user", LogDetailScope{UserId: 2}, false},
		{"other token of same user", LogDetailScope{UserId: 1, TokenId: 12}, false},
		{"token of wrong user", LogDetailScope{UserId: 2, TokenId: 11}, false},
		{"admin token stays scoped", LogDetailScope{UserId: 1, TokenId: 12, Admin: true}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			detail, err := GetLogDetail(context.Background(), entry.Id, tc.scope)
			if !tc.allowed {
				assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
				assert.Nil(t, detail)
				return
			}
			require.NoError(t, err)
			require.NotNil(t, detail)
			assert.Equal(t, LargeText("complete request"), detail.RequestBody)
			assert.Equal(t, LargeText("complete response"), detail.ResponseBody)
		})
	}
	missing, err := GetLogDetail(context.Background(), entries[2].Id, LogDetailScope{UserId: 1})
	require.NoError(t, err)
	assert.Nil(t, missing)
	require.NoError(t, LOG_DB.Where("log_id = ?", entry.Id).Delete(&LogDetail{}).Error)
	expired, err := GetLogDetail(context.Background(), entry.Id, LogDetailScope{UserId: 1})
	require.NoError(t, err)
	assert.Nil(t, expired)
	listed, _, err = GetUserLogs(1, LogFilter{}, 0, 2)
	require.NoError(t, err)
	assert.False(t, listed[1].HasDetail)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err = GetUserLogsWithContext(ctx, 1, LogFilter{}, 0, 100)
	assert.ErrorIs(t, err, context.Canceled)
	_, _, err = GetAllLogsWithContext(ctx, LogFilter{}, 0, 100)
	assert.ErrorIs(t, err, context.Canceled)
	_, err = GetLogByTokenIdWithContext(ctx, 11)
	assert.ErrorIs(t, err, context.Canceled)
	_, err = GetLogDetail(ctx, entry.Id, LogDetailScope{UserId: 1})
	assert.ErrorIs(t, err, context.Canceled)
	_, err = DeleteOldLogBatch(ctx, 8, 3)
	assert.ErrorIs(t, err, context.Canceled)
}

func TestLogRetentionBatchAndLease(t *testing.T) {
	useLogPerformanceDatabase(t)
	for i := range 7 {
		require.NoError(t, LOG_DB.Create(&LogDetail{LogId: i + 1, CreatedAt: int64(i + 1), RequestBody: "retained body"}).Error)
	}
	for _, want := range []int64{2, 2, 1, 0} {
		deleted, err := deleteExpiredLogDetailBatch(context.Background(), 6, 2)
		require.NoError(t, err)
		assert.Equal(t, want, deleted)
	}
	var retained []int64
	require.NoError(t, LOG_DB.Model(&LogDetail{}).Order("created_at").Pluck("created_at", &retained).Error)
	assert.Equal(t, []int64{6, 7}, retained)

	acquired, err := acquireLogDetailCleanupLease(context.Background(), "first-master")
	require.NoError(t, err)
	require.True(t, acquired)
	acquired, err = acquireLogDetailCleanupLease(context.Background(), "second-master")
	require.NoError(t, err)
	assert.False(t, acquired)
	require.NoError(t, DB.Model(&SystemTaskLock{}).
		Where("type = ?", logDetailCleanupLockType).Update("locked_until", 1).Error)
	acquired, err = acquireLogDetailCleanupLease(context.Background(), "second-master")
	require.NoError(t, err)
	assert.True(t, acquired)

	require.NoError(t, DB.Where("type = ?", logDetailCleanupLockType).Delete(&SystemTaskLock{}).Error)
	type leaseResult struct {
		acquired bool
		err      error
	}
	start := make(chan struct{})
	results := make(chan leaseResult, 2)
	for _, owner := range []string{"competing-master-a", "competing-master-b"} {
		go func() {
			<-start
			acquired, err := acquireLogDetailCleanupLease(context.Background(), owner)
			results <- leaseResult{acquired, err}
		}()
	}
	close(start)
	winners := 0
	for range 2 {
		result := <-results
		assert.NoError(t, result.err)
		if result.acquired {
			winners++
		}
	}
	assert.Equal(t, 1, winners, "only one master may run a retention pass")

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = deleteExpiredLogDetailBatch(ctx, 10, 2)
	assert.ErrorIs(t, err, context.Canceled)
	assert.ErrorIs(t, WaitLogCleanupBatch(ctx), context.Canceled)
	_, err = acquireLogDetailCleanupLease(ctx, "cancelled-master")
	assert.ErrorIs(t, err, context.Canceled)
}

func TestUserLogCountStaysExactAboveTenThousand(t *testing.T) {
	useLogPerformanceDatabase(t)
	entries := make([]Log, 10001)
	for i := range entries {
		entries[i] = Log{UserId: 42, CreatedAt: 1}
	}
	require.NoError(t, LOG_DB.CreateInBatches(entries, 100).Error)
	logs, total, err := GetUserLogs(42, LogFilter{}, -1, -1)
	require.NoError(t, err)
	assert.EqualValues(t, 10001, total)
	assert.Len(t, logs, common.ItemsPerPage)
	logs, _, err = GetAllLogs(LogFilter{}, -1, 1000)
	require.NoError(t, err)
	assert.Len(t, logs, 100)
}
