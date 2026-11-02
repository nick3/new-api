package common

import (
	"fmt"
	"math"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestPageQueryNormalizesInvalidBounds(t *testing.T) {
	for _, tc := range []struct {
		query      string
		page, size int
	}{
		{"", 1, ItemsPerPage},
		{"p=-2&page_size=-1", 1, ItemsPerPage},
		{"p=0&ps=-5", 1, ItemsPerPage},
		{"size=-3", 1, ItemsPerPage},
		{"p=invalid&page_size=invalid", 1, ItemsPerPage},
		{"p=2&ps=25", 2, 25},
		{"size=30", 1, 30},
		{"page_size=1&ps=25", 1, 1},
		{"page_size=1000", 1, 100},
		{fmt.Sprintf("p=%d&page_size=100", math.MaxInt), math.MaxInt / 100, 100},
		{"p=999999999999999999999999999&page_size=10", 1, 10},
	} {
		t.Run(tc.query, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest("GET", "/?"+tc.query, nil)
			page := GetPageQuery(ctx)
			assert.Equal(t, tc.page, page.GetPage())
			assert.Equal(t, tc.size, page.GetPageSize())
			assert.GreaterOrEqual(t, page.GetStartIdx(), 0)
			assert.GreaterOrEqual(t, page.GetEndIdx(), page.GetStartIdx())
		})
	}
}
