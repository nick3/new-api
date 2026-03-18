package common

import (
	"bytes"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/constant"

	"github.com/gin-gonic/gin"
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
