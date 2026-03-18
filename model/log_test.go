package model

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"

	"github.com/gin-gonic/gin"
)

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
