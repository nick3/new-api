package common

import (
	"testing"

	"github.com/QuantumNous/new-api/constant"
)

func TestGetFullRequestURL_OpenAIBaseURLPathHandling(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		baseURL    string
		requestURL string
		channelType int
		expected   string
	}{
		{
			name:        "cloudflare gateway is handled first (openai)",
			baseURL:     "https://gateway.ai.cloudflare.com/account/gateway/openai",
			requestURL:  "/v1/chat/completions",
			channelType: constant.ChannelTypeOpenAI,
			expected:    "https://gateway.ai.cloudflare.com/account/gateway/openai/chat/completions",
		},
		{
			name:        "openai baseURL no path keeps /v1",
			baseURL:     "https://api.openai.com",
			requestURL:  "/v1/chat/completions",
			channelType: constant.ChannelTypeOpenAI,
			expected:    "https://api.openai.com/v1/chat/completions",
		},
		{
			name:        "openai baseURL trailing slash treated as no path",
			baseURL:     "https://api.openai.com/",
			requestURL:  "/v1/chat/completions",
			channelType: constant.ChannelTypeOpenAI,
			expected:    "https://api.openai.com/v1/chat/completions",
		},
		{
			name:        "openai baseURL with path strips /v1",
			baseURL:     "https://api.openai.com/v2",
			requestURL:  "/v1/chat/completions",
			channelType: constant.ChannelTypeOpenAI,
			expected:    "https://api.openai.com/v2/chat/completions",
		},
		{
			name:        "openai baseURL with path and trailing slash strips /v1",
			baseURL:     "https://api.openai.com/v2/",
			requestURL:  "/v1/chat/completions",
			channelType: constant.ChannelTypeOpenAI,
			expected:    "https://api.openai.com/v2/chat/completions",
		},
		{
			name:        "non-openai channel does not strip /v1 even if baseURL has path",
			baseURL:     "https://openrouter.ai/api",
			requestURL:  "/v1/chat/completions",
			channelType: constant.ChannelTypeOpenRouter,
			expected:    "https://openrouter.ai/api/v1/chat/completions",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := GetFullRequestURL(tt.baseURL, tt.requestURL, tt.channelType)
			if got != tt.expected {
				t.Fatalf("GetFullRequestURL() = %q, want %q", got, tt.expected)
			}
		})
	}
}
