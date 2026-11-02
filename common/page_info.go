package common

import (
	"strconv"

	"github.com/gin-gonic/gin"
)

type PageInfo struct {
	Page     int `json:"page"`      // page num 页码
	PageSize int `json:"page_size"` // page size 页大小

	Total int `json:"total"` // 总条数，后设置
	Items any `json:"items"` // 数据，后设置
}

func (p *PageInfo) GetStartIdx() int {
	return (p.Page - 1) * p.PageSize
}

func (p *PageInfo) GetEndIdx() int {
	return p.Page * p.PageSize
}

func (p *PageInfo) GetPageSize() int {
	return p.PageSize
}

func (p *PageInfo) GetPage() int {
	return p.Page
}

func (p *PageInfo) SetTotal(total int) {
	p.Total = total
}

func (p *PageInfo) SetItems(items any) {
	p.Items = items
}

func GetPageQuery(c *gin.Context) *PageInfo {
	page, err := strconv.Atoi(c.Query("p"))
	if err != nil {
		page = 1
	}
	pageSize := 0
	// Preserve the legacy aliases, but never pass non-positive limits to GORM.
	for _, key := range []string{"page_size", "ps", "size"} {
		value, err := strconv.Atoi(c.Query(key))
		if err == nil && value > 0 {
			pageSize = value
			break
		}
	}
	if pageSize == 0 {
		pageSize = max(ItemsPerPage, 1)
	}
	pageSize = min(pageSize, 100)
	// Keep both offset and end-index multiplication within the int range.
	maxPage := int(^uint(0)>>1) / pageSize
	page = min(max(page, 1), maxPage)
	return &PageInfo{Page: page, PageSize: pageSize}
}
