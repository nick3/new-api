package controller

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting/operation_setting"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// callLogHandler runs a log handler as the given user and returns the JSON
// lines of the response.
func callLogHandler(t *testing.T, handler gin.HandlerFunc, userId int, role int, query string) []map[string]any {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/api/log?"+query, nil)
	ctx.Set("id", userId)
	ctx.Set("role", role)
	handler(ctx)
	var lines []map[string]any
	for line := range strings.SplitSeq(strings.TrimSpace(recorder.Body.String()), "\n") {
		var value map[string]any
		require.NoError(t, common.UnmarshalJsonStr(line, &value))
		lines = append(lines, value)
	}
	return lines
}

func exportedRequestIds(lines []map[string]any) []any {
	ids := make([]any, 0, len(lines))
	for _, line := range lines[:len(lines)-1] {
		ids = append(ids, line["request_id"])
	}
	return ids
}

// seedExportLogs stores logs of two users: three in the last hour and one
// from 400 days ago.
func seedExportLogs(t *testing.T, mainDB *gorm.DB, logDB *gorm.DB, now int64) {
	t.Helper()
	require.NoError(t, mainDB.Create(&model.Channel{Id: 9, Name: "primary"}).Error)
	logs := []model.Log{
		{UserId: 1, Username: "alice", CreatedAt: now - 3600, Type: model.LogTypeConsume, ModelName: "gpt-a", ChannelId: 9, Quota: 10, RequestId: "a-1", Other: `{"admin_info":{"use_channel":["9"]}}`},
		{UserId: 2, Username: "bob", CreatedAt: now - 1800, Type: model.LogTypeConsume, ModelName: "gpt-b", ChannelId: 9, Quota: 20, RequestId: "b-1"},
		{UserId: 1, Username: "alice", CreatedAt: now - 60, Type: model.LogTypeError, ModelName: "gpt-a", RequestId: "a-2"},
		{UserId: 1, Username: "alice", CreatedAt: now - 400*24*3600, Type: model.LogTypeConsume, ModelName: "gpt-a", RequestId: "a-old"},
	}
	for i := range logs {
		require.NoError(t, logDB.Create(&logs[i]).Error)
	}
}

func useLogExportDatabases(t *testing.T, mainDB *gorm.DB, logDB *gorm.DB, mainType common.DatabaseType, logType common.DatabaseType) {
	t.Helper()
	previousDB, previousLogDB := model.DB, model.LOG_DB
	previousMain, previousLog := common.MainDatabaseType(), common.LogDatabaseType()
	previousRedis, previousMemory := common.RedisEnabled, common.MemoryCacheEnabled
	model.DB, model.LOG_DB = mainDB, logDB
	common.SetDatabaseTypes(mainType, logType)
	common.RedisEnabled, common.MemoryCacheEnabled = false, false
	t.Cleanup(func() {
		model.DB, model.LOG_DB = previousDB, previousLogDB
		common.SetDatabaseTypes(previousMain, previousLog)
		common.RedisEnabled, common.MemoryCacheEnabled = previousRedis, previousMemory
	})
}

func TestLogExportDatabaseMatrix(t *testing.T) {
	gin.SetMode(gin.TestMode)
	previousMaster := common.IsMasterNode
	common.IsMasterNode = true
	t.Cleanup(func() { common.IsMasterNode = previousMaster })
	for _, tc := range []struct {
		kind, env string
		typ       common.DatabaseType
	}{
		{"sqlite", "", common.DatabaseTypeSQLite},
		{"mysql", "AUDIT_MYSQL_DSN", common.DatabaseTypeMySQL},
		{"postgres", "AUDIT_POSTGRES_DSN", common.DatabaseTypePostgreSQL},
		{"clickhouse", "AUDIT_CLICKHOUSE_DSN", common.DatabaseTypeClickHouse},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			dsn := os.Getenv(tc.env)
			if tc.env != "" && dsn == "" {
				t.Skip(tc.env + " is not configured")
			}
			db, isolatedDSN := newAuditTestDatabase(t, tc.kind, dsn)
			mainDB, mainType := db, tc.typ
			if tc.kind == "clickhouse" {
				mainDB, _ = newAuditTestDatabase(t, "sqlite", "")
				mainType = common.DatabaseTypeSQLite
			}
			useLogExportDatabases(t, mainDB, db, mainType, tc.typ)
			require.NoError(t, mainDB.AutoMigrate(&model.Channel{}))
			if tc.kind == "clickhouse" {
				t.Setenv("LOG_SQL_DSN", isolatedDSN)
				require.NoError(t, model.InitLogDB())
			} else {
				require.NoError(t, db.AutoMigrate(&model.Log{}))
			}
			versionSQL := "SELECT version()"
			if tc.kind == "sqlite" {
				versionSQL = "SELECT sqlite_version()"
			}
			var version string
			require.NoError(t, model.LOG_DB.Raw(versionSQL).Scan(&version).Error)
			t.Logf("log database: %s %s", tc.kind, version)
			now := time.Now().Unix()
			seedExportLogs(t, mainDB, model.LOG_DB, now)
			query := fmt.Sprintf("start_timestamp=%d&end_timestamp=%d", now-2*24*3600, now+3600)

			listed := callLogHandler(t, GetUserLogs, 1, common.RoleCommonUser, query)[0]
			require.Equal(t, true, listed["success"])
			assert.EqualValues(t, 2, listed["data"].(map[string]any)["total"])
			listed = callLogHandler(t, GetAllLogs, 3, common.RoleAdminUser, query+"&username=alice")[0]
			require.Equal(t, true, listed["success"])
			assert.EqualValues(t, 2, listed["data"].(map[string]any)["total"])

			own := callLogHandler(t, ExportUserLogs, 1, common.RoleCommonUser, query)
			require.Len(t, own, 3)
			assert.Equal(t, []any{"a-2", "a-1"}, exportedRequestIds(own))
			assert.Equal(t, map[string]any{"success": true, "message": "", "data": map[string]any{"count": float64(2)}}, own[2])
			assert.Equal(t, float64(1), own[0]["id"], "user exports carry list positions, not row ids")
			assert.Empty(t, own[1]["channel_name"])
			assert.NotContains(t, own[1]["other"], "admin_info")

			all := callLogHandler(t, ExportAllLogs, 3, common.RoleAdminUser, query+"&model_name=gpt-%25")
			require.Len(t, all, 4)
			assert.Equal(t, []any{"a-2", "b-1", "a-1"}, exportedRequestIds(all))
			assert.Equal(t, "primary", all[2]["channel_name"])
			assert.Contains(t, all[2]["other"], "admin_info")
			assert.Equal(t, true, all[3]["success"])
		})
	}
}

func TestLogExportRules(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, _ := newAuditTestDatabase(t, "sqlite", "")
	useLogExportDatabases(t, db, db, common.DatabaseTypeSQLite, common.DatabaseTypeSQLite)
	require.NoError(t, db.AutoMigrate(&model.Channel{}, &model.Log{}, &model.QuotaData{}))
	now := time.Now().Unix()
	seedExportLogs(t, db, db, now)
	logSetting := operation_setting.GetLogSetting()
	previousSetting := *logSetting
	t.Cleanup(func() { *logSetting = previousSetting })
	recent := fmt.Sprintf("start_timestamp=%d&end_timestamp=%d", now-2*24*3600, now)
	tooLong := fmt.Sprintf("start_timestamp=%d&end_timestamp=%d", now-366*24*3600, now)

	t.Run("time range", func(t *testing.T) {
		rejected := callLogHandler(t, ExportAllLogs, 3, common.RoleAdminUser, tooLong)
		require.Len(t, rejected, 1)
		assert.Equal(t, false, rejected[0]["success"])
		assert.Equal(t, "The time range cannot exceed {{days}} days", rejected[0]["message_key"])
		assert.Equal(t, map[string]any{"days": float64(365)}, rejected[0]["message_params"])

		assert.Equal(t, false, callLogHandler(t, GetUserLogs, 1, common.RoleCommonUser, tooLong)[0]["success"])
		assert.Equal(t, false, callLogHandler(t, GetLogsSelfStat, 1, common.RoleCommonUser, tooLong)[0]["success"])
		assert.Equal(t, true, callLogHandler(t, GetUserLogs, 3, common.RoleAdminUser, tooLong)[0]["success"], "administrators search their own logs without a limit")

		// The dashboard follows the same range instead of its old one-month limit.
		fortyDays := fmt.Sprintf("start_timestamp=%d&end_timestamp=%d", now-40*24*3600, now)
		for _, handler := range []gin.HandlerFunc{GetUserQuotaDates, GetUserFlowQuotaDates} {
			assert.Equal(t, "The time range cannot exceed {{days}} days", callLogHandler(t, handler, 1, common.RoleCommonUser, tooLong)[0]["message_key"])
			assert.Equal(t, true, callLogHandler(t, handler, 1, common.RoleCommonUser, fortyDays)[0]["success"])
		}

		// Without a start, a user's search reaches back the whole range.
		listed := callLogHandler(t, GetUserLogs, 1, common.RoleCommonUser, "")[0]
		assert.Equal(t, true, listed["success"])
		assert.EqualValues(t, 2, listed["data"].(map[string]any)["total"])

		logSetting.MaxRangeDays = 400
		assert.Equal(t, true, callLogHandler(t, GetUserLogs, 1, common.RoleCommonUser, tooLong)[0]["success"])
		logSetting.MaxRangeDays = previousSetting.MaxRangeDays
	})

	t.Run("user export switch", func(t *testing.T) {
		logSetting.UserExportEnabled = false
		t.Cleanup(func() { logSetting.UserExportEnabled = previousSetting.UserExportEnabled })
		disabled := callLogHandler(t, ExportUserLogs, 1, common.RoleCommonUser, recent)
		require.Len(t, disabled, 1)
		assert.Equal(t, "Log export is disabled", disabled[0]["message_key"])
		assert.Equal(t, true, callLogHandler(t, ExportUserLogs, 3, common.RoleAdminUser, recent)[0]["success"], "administrators export their own logs even when users cannot")
	})

	t.Run("one export per user", func(t *testing.T) {
		release, ok, err := service.AcquireLogExportLock(1)
		require.NoError(t, err)
		require.True(t, ok)
		busy := callLogHandler(t, ExportUserLogs, 1, common.RoleCommonUser, recent)
		require.Len(t, busy, 1)
		assert.Equal(t, "Another log export is running. Try again after it finishes.", busy[0]["message_key"])
		other := callLogHandler(t, ExportUserLogs, 2, common.RoleCommonUser, recent)
		assert.Equal(t, true, other[len(other)-1]["success"], "other users are not blocked")
		release()
		assert.Len(t, callLogHandler(t, ExportUserLogs, 1, common.RoleCommonUser, recent), 3)
	})
}

func TestAcquireLogExportLock(t *testing.T) {
	for _, useRedis := range []bool{false, true} {
		t.Run(fmt.Sprintf("redis=%v", useRedis), func(t *testing.T) {
			previousRedis, previousClient := common.RedisEnabled, common.RDB
			common.RedisEnabled = useRedis
			if useRedis {
				server := miniredis.RunT(t)
				common.RDB = redis.NewClient(&redis.Options{Addr: server.Addr()})
				require.NoError(t, common.RDB.Ping(context.Background()).Err())
			}
			t.Cleanup(func() { common.RedisEnabled, common.RDB = previousRedis, previousClient })

			release, ok, err := service.AcquireLogExportLock(1)
			require.NoError(t, err)
			require.True(t, ok)
			_, ok, err = service.AcquireLogExportLock(1)
			require.NoError(t, err)
			assert.False(t, ok, "a second export of the same user must wait")
			releaseOther, ok, err := service.AcquireLogExportLock(2)
			require.NoError(t, err)
			assert.True(t, ok)
			releaseOther()
			release()
			releaseAgain, ok, err := service.AcquireLogExportLock(1)
			require.NoError(t, err)
			assert.True(t, ok, "a finished export frees the user")
			releaseAgain()
		})
	}
}

func TestLogDetailHTTPDatabaseMatrix(t *testing.T) {
	for _, tc := range []struct {
		kind, env string
		typ       common.DatabaseType
	}{
		{"sqlite", "", common.DatabaseTypeSQLite},
		{"mysql", "AUDIT_MYSQL_DSN", common.DatabaseTypeMySQL},
		{"postgres", "AUDIT_POSTGRES_DSN", common.DatabaseTypePostgreSQL},
		{"clickhouse", "AUDIT_CLICKHOUSE_DSN", common.DatabaseTypeClickHouse},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			dsn := os.Getenv(tc.env)
			if tc.env != "" && dsn == "" {
				t.Skip(tc.env + " is not configured")
			}
			mainDB, _ := newAuditTestDatabase(t, "sqlite", "")
			logDB, isolatedDSN := newAuditTestDatabase(t, tc.kind, dsn)
			useLogExportDatabases(t, mainDB, logDB, common.DatabaseTypeSQLite, tc.typ)
			require.NoError(t, mainDB.AutoMigrate(&model.Channel{}))
			if tc.kind == "clickhouse" {
				previousMaster := common.IsMasterNode
				common.IsMasterNode = true
				t.Cleanup(func() { common.IsMasterNode = previousMaster })
				t.Setenv("LOG_SQL_DSN", isolatedDSN)
				require.NoError(t, model.InitLogDB())
				logDB = model.LOG_DB
			} else {
				require.NoError(t, logDB.AutoMigrate(&model.Log{}, &model.LogDetail{}))
			}
			now := time.Now().Unix()
			entries := []model.Log{
				{UserId: 2, TokenId: 22, CreatedAt: now - 10, RequestId: "other"},
				{UserId: 1, TokenId: 11, CreatedAt: now - 5, RequestId: "saved"},
				{UserId: 1, TokenId: 12, CreatedAt: now, RequestId: "missing"},
			}
			for i := range entries {
				require.NoError(t, logDB.Create(&entries[i]).Error)
			}
			if tc.kind == "clickhouse" {
				logs, _, err := model.GetUserLogsWithContext(context.Background(), 1, model.LogFilter{}, 0, 100)
				require.NoError(t, err)
				require.Len(t, logs, 2)
				assert.False(t, logs[0].HasDetail)
				assert.Zero(t, logs[0].DetailId)
				_, err = model.GetLogDetail(context.Background(), 1, model.LogDetailScope{Admin: true})
				assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
				// ClickHouse deliberately uses one synchronous mutation, not row batches.
				deleted, err := model.DeleteOldLogBatch(context.Background(), now, 1)
				require.NoError(t, err)
				assert.EqualValues(t, 2, deleted)
				var retained int64
				require.NoError(t, logDB.Model(&model.Log{}).Count(&retained).Error)
				assert.EqualValues(t, 1, retained)
				return
			}
			body := strings.Repeat("x", 1<<20)
			require.NoError(t, logDB.Create(&model.LogDetail{LogId: entries[1].Id, RequestBody: model.LargeText(body)}).Error)
			listed := callLogHandler(t, GetUserLogs, 1, common.RoleCommonUser, "")[0]
			require.Equal(t, true, listed["success"])
			items := listed["data"].(map[string]any)["items"].([]any)
			saved := items[1].(map[string]any)
			assert.EqualValues(t, 2, saved["id"])
			assert.EqualValues(t, entries[1].Id, saved["detail_id"])
			assert.Equal(t, true, saved["has_detail"])
			assert.NotContains(t, saved, "detail")

			for _, test := range []struct {
				name                  string
				user, role, token, id int
				handler               gin.HandlerFunc
				status                int
				hasBody               bool
			}{
				{"owner", 1, common.RoleCommonUser, 0, entries[1].Id, GetUserLogDetail, http.StatusOK, true},
				{"other user", 2, common.RoleCommonUser, 0, entries[1].Id, GetUserLogDetail, http.StatusNotFound, false},
				{"admin", 3, common.RoleAdminUser, 0, entries[1].Id, GetLogDetail, http.StatusOK, true},
				{"admin self stays scoped", 3, common.RoleAdminUser, 0, entries[1].Id, GetUserLogDetail, http.StatusNotFound, false},
				{"root", 3, common.RoleRootUser, 0, entries[1].Id, GetLogDetail, http.StatusOK, true},
				{"own token", 1, common.RoleCommonUser, 11, entries[1].Id, GetLogDetailByKey, http.StatusOK, true},
				{"other token", 1, common.RoleRootUser, 12, entries[1].Id, GetLogDetailByKey, http.StatusNotFound, false},
				{"wrong owner", 2, common.RoleCommonUser, 11, entries[1].Id, GetLogDetailByKey, http.StatusNotFound, false},
				{"missing body", 1, common.RoleCommonUser, 0, entries[2].Id, GetUserLogDetail, http.StatusOK, false},
				{"missing log", 1, common.RoleCommonUser, 0, entries[2].Id + 1000, GetUserLogDetail, http.StatusNotFound, false},
				{"invalid id", 1, common.RoleCommonUser, 0, -1, GetUserLogDetail, http.StatusNotFound, false},
			} {
				t.Run(test.name, func(t *testing.T) {
					recorder := httptest.NewRecorder()
					ctx, _ := gin.CreateTestContext(recorder)
					ctx.Request = httptest.NewRequest(http.MethodGet, "/api/log/detail", nil)
					ctx.Params = gin.Params{{Key: "id", Value: fmt.Sprint(test.id)}}
					ctx.Set("id", test.user)
					ctx.Set("role", test.role)
					ctx.Set("token_id", test.token)
					test.handler(ctx)
					require.Equal(t, test.status, recorder.Code)
					assert.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
					var result struct {
						Success bool
						Data    *model.LogDetail
					}
					require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &result))
					if test.hasBody {
						require.NotNil(t, result.Data)
						assert.True(t, string(result.Data.RequestBody) == body)
					} else {
						assert.Nil(t, result.Data)
					}
				})
			}
			require.NoError(t, logDB.Where("log_id = ?", entries[1].Id).Delete(&model.LogDetail{}).Error)
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodGet, "/api/log/detail", nil)
			ctx.Params = gin.Params{{Key: "id", Value: fmt.Sprint(entries[1].Id)}}
			ctx.Set("id", 1)
			GetLogDetail(ctx)
			assert.JSONEq(t, `{"success":true,"message":"","data":null}`, recorder.Body.String())
		})
	}
}

func TestLogDetailCredentialScopes(t *testing.T) {
	user, _ := setupAccessTokenAudit(t)
	t.Setenv("LOG_SQL_DSN", "")
	require.NoError(t, model.InitLogDB())
	require.NoError(t, model.DB.AutoMigrate(&model.LogDetail{}, &model.Token{}))
	token := &model.Token{UserId: user.Id, Key: strings.Repeat("k", 48), Name: "detail key", Status: common.TokenStatusEnabled}
	require.NoError(t, model.DB.Create(token).Error)
	entries := []model.Log{
		{UserId: user.Id, TokenId: token.Id, CreatedAt: time.Now().Unix()},
		{UserId: user.Id + 1, TokenId: token.Id + 1, CreatedAt: time.Now().Unix()},
	}
	for i := range entries {
		require.NoError(t, model.LOG_DB.Create(&entries[i]).Error)
		require.NoError(t, model.LOG_DB.Create(&model.LogDetail{LogId: entries[i].Id, RequestBody: "saved request"}).Error)
	}
	usageRead, _ := createScopedAccessToken(t, user.Id, 0, "usage:read")
	logRead, _ := createScopedAccessToken(t, user.Id, 0, "log:read")
	profileRead, _ := createScopedAccessToken(t, user.Id, 0, "profile:read")
	expired, _ := createScopedAccessToken(t, user.Id, time.Now().Unix()-1, "usage:read")
	router := newAccessTokenTestRouter()
	router.GET("/api/log/:id/detail", middleware.AdminAuth(), GetLogDetail)
	router.GET("/api/log/self/:id/detail", middleware.UserAuth(), GetUserLogDetail)
	router.GET("/api/log/token/:id/detail", middleware.TokenAuthReadOnly(), GetLogDetailByKey)
	for _, tc := range []struct {
		name, credential, path string
		status                 int
	}{
		{"own usage grant", usageRead, fmt.Sprintf("/api/log/self/%d/detail", entries[0].Id), http.StatusOK},
		{"usage grant cannot read another owner", usageRead, fmt.Sprintf("/api/log/self/%d/detail", entries[1].Id), http.StatusNotFound},
		{"usage grant cannot enter admin route", usageRead, fmt.Sprintf("/api/log/%d/detail", entries[1].Id), http.StatusForbidden},
		{"admin log grant", logRead, fmt.Sprintf("/api/log/%d/detail", entries[1].Id), http.StatusOK},
		{"unrelated grant", profileRead, fmt.Sprintf("/api/log/self/%d/detail", entries[0].Id), http.StatusForbidden},
		{"expired grant", expired, fmt.Sprintf("/api/log/self/%d/detail", entries[0].Id), http.StatusUnauthorized},
		{"API key owns detail", token.Key, fmt.Sprintf("/api/log/token/%d/detail", entries[0].Id), http.StatusOK},
		{"API key cannot cross token boundary", token.Key, fmt.Sprintf("/api/log/token/%d/detail", entries[1].Id), http.StatusNotFound},
		{"personal token cannot enter API key route", profileRead, fmt.Sprintf("/api/log/token/%d/detail", entries[0].Id), http.StatusUnauthorized},
		{"no credential", "", fmt.Sprintf("/api/log/self/%d/detail", entries[0].Id), http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := accessTokenRequest(router, http.MethodGet, tc.path, tc.credential, "", "")
			assert.Equal(t, tc.status, response.Code)
		})
	}
	require.NoError(t, model.DB.Model(&model.Token{}).Where("id = ?", token.Id).Update("status", common.TokenStatusDisabled).Error)
	response := accessTokenRequest(router, http.MethodGet, fmt.Sprintf("/api/log/token/%d/detail", entries[0].Id), token.Key, "", "")
	assert.Equal(t, http.StatusUnauthorized, response.Code)
}
