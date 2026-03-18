package relay

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"

	"github.com/gin-gonic/gin"
)

// captureStructuredRequestBodyForLog 记录最终发送到上游的结构化 JSON 请求体。
func captureStructuredRequestBodyForLog(c *gin.Context, jsonData []byte) {
	if len(jsonData) == 0 {
		return
	}
	common.CapturePayloadStringForLog(c, constant.ContextKeyLoggedRequestBody, string(jsonData))
}
