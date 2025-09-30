package common

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"one-api/constant"

	"github.com/gin-gonic/gin"
)

const (
	maxLogPayloadRunes = 2048
	truncatedSuffixFmt = "… [truncated %d chars]"
)

func fullPayloadKeyFor(previewKey constant.ContextKey) (constant.ContextKey, bool) {
	switch previewKey {
	case constant.ContextKeyLoggedRequestBody:
		return constant.ContextKeyLoggedRequestBodyFull, true
	case constant.ContextKeyLoggedResponseBody:
		return constant.ContextKeyLoggedResponseBodyFull, true
	default:
		return "", false
	}
}

func setFullPayload(c *gin.Context, previewKey constant.ContextKey, segments []string) {
	if c == nil {
		return
	}
	fullKey, ok := fullPayloadKeyFor(previewKey)
	if !ok {
		return
	}
	if len(segments) == 0 {
		c.Set(string(fullKey), []string{})
		return
	}
	// Ensure we don't retain caller slices.
	copySegments := append([]string(nil), segments...)
	c.Set(string(fullKey), copySegments)
}

func appendFullPayloadSegment(c *gin.Context, previewKey constant.ContextKey, segment string) {
	if c == nil || segment == "" {
		return
	}
	fullKey, ok := fullPayloadKeyFor(previewKey)
	if !ok {
		return
	}
	if existing, exists := c.Get(string(fullKey)); exists {
		switch payload := existing.(type) {
		case []string:
			payload = append(payload, segment)
			c.Set(string(fullKey), payload)
			return
		case string:
			c.Set(string(fullKey), []string{payload, segment})
			return
		}
	}
	c.Set(string(fullKey), []string{segment})
}

// GetFullPayloadString joins the accumulated segments stored under the provided key.
// It returns an empty string when no data has been captured.
func GetFullPayloadString(c *gin.Context, key constant.ContextKey) string {
	if c == nil {
		return ""
	}
	value, exists := c.Get(string(key))
	if !exists {
		return ""
	}
	switch payload := value.(type) {
	case []string:
		return strings.Join(payload, "")
	case string:
		return payload
	case []byte:
		return string(payload)
	default:
		return fmt.Sprintf("%v", payload)
	}
}

func isBinaryPayload(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	if !utf8.Valid(data) {
		return true
	}
	sample := data
	if len(sample) > 256 {
		sample = sample[:256]
	}
	var controlCount int
	for _, r := range string(sample) {
		if r == '\n' || r == '\r' || r == '\t' {
			continue
		}
		if r < 0x20 && !unicode.IsPrint(r) {
			controlCount++
		}
	}
	return controlCount > len(sample)/10 // heuristically treat as binary if >10% control chars
}

func truncatedSuffix(overflow int) string {
	if overflow < 0 {
		overflow = 0
	}
	return fmt.Sprintf(truncatedSuffixFmt, overflow)
}

func applyLogLimit(value string) string {
	runes := []rune(value)
	if len(runes) <= maxLogPayloadRunes {
		return value
	}
	trimmed := string(runes[:maxLogPayloadRunes])
	return trimmed + truncatedSuffix(len(runes)-maxLogPayloadRunes)
}

func formatPayloadForLog(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	if isBinaryPayload(data) {
		return fmt.Sprintf("[binary payload omitted: %d bytes]", len(data))
	}
	return applyLogLimit(string(data))
}

func setPayloadIfEmpty(c *gin.Context, key constant.ContextKey, value string) {
	if value == "" {
		return
	}
	if existing := c.GetString(string(key)); existing != "" {
		return
	}
	c.Set(string(key), value)
}

// CapturePayloadForLog stores a truncated preview of the given byte slice under the provided context key.
// It only sets the payload if one has not already been captured.
func CapturePayloadForLog(c *gin.Context, key constant.ContextKey, data []byte) string {
	preview := formatPayloadForLog(data)
	setPayloadIfEmpty(c, key, preview)
	if len(data) > 0 && !isBinaryPayload(data) {
		setFullPayload(c, key, []string{string(data)})
	}
	return preview
}

// CapturePayloadStringForLog stores a string payload after applying the global truncation rules.
// It only writes when the key is not already populated.
func CapturePayloadStringForLog(c *gin.Context, key constant.ContextKey, value string) string {
	if value == "" {
		return ""
	}
	preview := applyLogLimit(value)
	setPayloadIfEmpty(c, key, preview)
	setFullPayload(c, key, []string{value})
	return preview
}

// AppendPayloadChunkForLog appends streaming chunks while respecting the global truncation limit.
func AppendPayloadChunkForLog(c *gin.Context, key constant.ContextKey, chunk string) {
	chunk = strings.TrimSpace(chunk)
	if chunk == "" || chunk == "[DONE]" {
		return
	}
	existing := c.GetString(string(key))
	if existing == "" {
		c.Set(string(key), applyLogLimit(chunk))
		appendFullPayloadSegment(c, key, chunk)
		return
	}
	if strings.Contains(existing, "[truncated") {
		appendFullPayloadSegment(c, key, chunk)
		return
	}
	existingRunes := []rune(existing)
	chunkRunes := []rune(chunk)
	total := len(existingRunes) + len(chunkRunes)
	if total <= maxLogPayloadRunes {
		c.Set(string(key), existing+chunk)
		appendFullPayloadSegment(c, key, chunk)
		return
	}
	remaining := maxLogPayloadRunes - len(existingRunes)
	if remaining <= 0 {
		suffix := truncatedSuffix(len(chunkRunes))
		c.Set(string(key), string(existingRunes[:maxLogPayloadRunes])+suffix)
		appendFullPayloadSegment(c, key, chunk)
		return
	}
	trimmedChunk := string(chunkRunes[:remaining])
	overflow := total - maxLogPayloadRunes
	c.Set(string(key), existing+trimmedChunk+truncatedSuffix(overflow))
	appendFullPayloadSegment(c, key, chunk)
}
