package common

import (
	"bytes"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/constant"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestCaptureRequestBodyPreviewDoesNotPopulateFullPayload(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())

	storage, err := CreateBodyStorage(bytes.Repeat([]byte{0x00}, 9000))
	if err != nil {
		t.Fatalf("CreateBodyStorage failed: %v", err)
	}
	defer storage.Close()

	captureRequestBodyPreview(ctx, storage)

	gotPreview := ctx.GetString(string(constant.ContextKeyLoggedRequestBody))
	if gotPreview != "[binary payload omitted: 8192 bytes]" {
		t.Fatalf("unexpected preview: %q", gotPreview)
	}

	if gotFull := GetFullPayloadString(ctx, constant.ContextKeyLoggedRequestBodyFull); gotFull != "" {
		t.Fatalf("expected empty full payload, got %q", gotFull)
	}
}

func TestCapturePayloadStringForLogStoresFullPayload(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())

	body := `{"message":"hello"}`
	CapturePayloadStringForLog(ctx, constant.ContextKeyLoggedRequestBody, body)

	if got := ctx.GetString(string(constant.ContextKeyLoggedRequestBody)); got != body {
		t.Fatalf("unexpected preview payload: %q", got)
	}
	if got := GetFullPayloadString(ctx, constant.ContextKeyLoggedRequestBodyFull); got != body {
		t.Fatalf("unexpected full payload: %q", got)
	}
}

func TestResolvePayloadForLogDetailKeepsFullText(t *testing.T) {
	body := `{"message":"` + strings.Repeat("a", 9000) + `"}`

	got := ResolvePayloadForLogDetail([]byte(body))
	if got != body {
		t.Fatalf("expected full body to be preserved")
	}
}

func TestPayloadPreviewPreservesUnicodeLimitAndFullCapture(t *testing.T) {
	for _, tc := range []struct {
		name, body, preview string
	}{
		{"at limit", strings.Repeat("你", 2048), strings.Repeat("你", 2048)},
		{"above limit", strings.Repeat("你🙂", 1025), strings.Repeat("你🙂", 1024) + "… [truncated 2 chars]"},
		{"large ascii", strings.Repeat("x", 1<<20), strings.Repeat("x", 2048) + "… [truncated 1046528 chars]"},
		{"invalid unicode", strings.Repeat("\xff", 2049), strings.Repeat("�", 2048) + "… [truncated 1 chars]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.preview, applyLogLimit(tc.body))
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			CapturePayloadStringForLog(ctx, constant.ContextKeyLoggedRequestBody, tc.body)
			assert.Equal(t, tc.body, GetFullPayloadString(ctx, constant.ContextKeyLoggedRequestBodyFull))
		})
	}
}
