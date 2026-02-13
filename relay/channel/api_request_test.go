package channel

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestCopyHeadersExcept_FiltersAuthHopByHopAndConnectionTokens(t *testing.T) {
	src := http.Header{}
	src.Set("X-Trace-Id", "abc")
	src.Add("X-Multi", "a")
	src.Add("X-Multi", "b")

	// auth headers (must be filtered)
	src.Set("Authorization", "Bearer user")
	src.Set("api-key", "user-key")
	src.Set("x-api-key", "user-x-key")
	src.Set("Cookie", "session=abc")

	// hop-by-hop / control headers (must be filtered)
	src.Set("Upgrade", "websocket")
	src.Set("Transfer-Encoding", "chunked")
	src.Set("Host", "example.com")
	src.Set("Content-Length", "123")
	src.Set("Keep-Alive", "timeout=5")
	src.Set("Proxy-Authenticate", "Basic realm=\"proxy\"")
	src.Set("Proxy-Authorization", "Basic abc")
	src.Set("Te", "trailers")
	src.Set("Trailer", "Foo")
	src.Set("Proxy-Connection", "keep-alive")

	// Connection declares additional hop-by-hop header names (must be filtered)
	src.Add("Connection", "X-Hop, keep-alive")
	src.Set("X-Hop", "1")

	deny := buildPassThroughHeaderDenySet(src, nil)
	dst := http.Header{}
	copyHeadersExcept(dst, src, deny)

	// allowed
	if got := dst.Get("X-Trace-Id"); got != "abc" {
		t.Fatalf("expected X-Trace-Id=abc, got %q", got)
	}
	if got := dst.Values("X-Multi"); !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Fatalf("expected X-Multi=[a b], got %#v", got)
	}

	// denied
	for _, k := range []string{
		"Authorization",
		"Api-Key",
		"X-Api-Key",
		"Cookie",
		"Connection",
		"Keep-Alive",
		"Proxy-Authenticate",
		"Proxy-Authorization",
		"Te",
		"Trailer",
		"Transfer-Encoding",
		"Upgrade",
		"Proxy-Connection",
		"Host",
		"Content-Length",
		"X-Hop",
	} {
		if len(dst.Values(k)) != 0 {
			t.Fatalf("expected %s to be filtered, got %#v", k, dst.Values(k))
		}
	}
}

func TestBuildPassThroughHeaderDenySet_ConnectionTokensAndExtraDeny(t *testing.T) {
	src := http.Header{}
	src.Add("Connection", " X-Hop , Foo ")

	deny := buildPassThroughHeaderDenySet(src, []string{"Sec-WebSocket-Key", "Content-Type"})

	for _, k := range []string{"x-hop", "foo", "sec-websocket-key", "content-type"} {
		if _, ok := deny[k]; !ok {
			t.Fatalf("expected denyset to include %q", k)
		}
	}
}

func TestProcessHeaderOverride_ChannelTestSkipsPassthroughRules(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	ctx.Request.Header.Set("X-Trace-Id", "trace-123")

	info := &relaycommon.RelayInfo{
		IsChannelTest: true,
		ChannelMeta: &relaycommon.ChannelMeta{
			HeadersOverride: map[string]any{
				"*": "",
			},
		},
	}

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Empty(t, headers)
}

func TestProcessHeaderOverride_ChannelTestSkipsClientHeaderPlaceholder(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	ctx.Request.Header.Set("X-Trace-Id", "trace-123")

	info := &relaycommon.RelayInfo{
		IsChannelTest: true,
		ChannelMeta: &relaycommon.ChannelMeta{
			HeadersOverride: map[string]any{
				"X-Upstream-Trace": "{client_header:X-Trace-Id}",
			},
		},
	}

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	_, ok := headers["X-Upstream-Trace"]
	require.False(t, ok)
}

func TestProcessHeaderOverride_NonTestKeepsClientHeaderPlaceholder(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	ctx.Request.Header.Set("X-Trace-Id", "trace-123")

	info := &relaycommon.RelayInfo{
		IsChannelTest: false,
		ChannelMeta: &relaycommon.ChannelMeta{
			HeadersOverride: map[string]any{
				"X-Upstream-Trace": "{client_header:X-Trace-Id}",
			},
		},
	}

	headers, err := processHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Equal(t, "trace-123", headers["X-Upstream-Trace"])
}
