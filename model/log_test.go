package model

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
			t.Setenv("MERGE_TEST_SQL_DSN", "local")
			var err error
			DB, _, err = chooseDB("MERGE_TEST_SQL_DSN", false)
			require.NoError(t, err)
			sqlDB, err := DB.DB()
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, sqlDB.Close()) })
			common.SetMainDatabaseType(common.DatabaseTypeSQLite)
			common.IsMasterNode = true
			common.LogConsumeEnabled, common.DataExportEnabled = true, false
			t.Setenv("LOG_SQL_DSN", "")
			if separate {
				common.SQLitePath = filepath.Join(t.TempDir(), "logs.db")
				t.Setenv("LOG_SQL_DSN", "local")
			}
			require.NoError(t, InitLogDB())
			logDB := LOG_DB
			if separate {
				logSQLDB, err := logDB.DB()
				require.NoError(t, err)
				t.Cleanup(func() { require.NoError(t, logSQLDB.Close()) })
				assert.False(t, DB.Migrator().HasTable(&LogDetail{}))
			}
			var version string
			require.NoError(t, logDB.Raw("SELECT sqlite_version()").Scan(&version).Error)
			t.Logf("SQLite %s, %s log database", version, name)
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
				RequestBodyPreview: request, ResponseBodyPreview: response,
			})
			common.CapturePayloadStringForLog(c, constant.ContextKeyLoggedRequestBody, request)
			common.CapturePayloadStringForLog(c, constant.ContextKeyLoggedResponseBody, response)
			RecordErrorLog(c, 42, 1, "test", "", "rejected", 11, 1, false, "default", other)
			for range 2 {
				require.NoError(t, migrateLOGDB())
			}
			var stored []*Log
			require.NoError(t, logDB.Order("id").Find(&stored).Error)
			require.Len(t, stored, 2)
			assert.Equal(t, 123, stored[0].Quota)
			attachLogDetails(stored)
			for _, entry := range stored {
				assert.Equal(t, "192.0.2.1", entry.Ip)
				assert.JSONEq(t, other.JSONString(), entry.Other)
				require.NotNil(t, entry.Detail)
				assert.Equal(t, LargeText(request), entry.Detail.RequestBody)
				assert.Equal(t, LargeText(response), entry.Detail.ResponseBody)
			}
			userLogs, err := GetLogByTokenId(11)
			require.NoError(t, err)
			require.Len(t, userLogs, 2)
			for _, entry := range userLogs {
				require.NotNil(t, entry.Detail)
				assert.JSONEq(t, `{"model_price":1.25}`, entry.Other)
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
