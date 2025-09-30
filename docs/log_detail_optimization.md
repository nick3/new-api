# Log Detail Retention Cleanup Optimization

## 问题说明

原始代码在清理过期的 `log_details` 记录时存在性能问题：
- `created_at` 字段没有索引，导致 `WHERE created_at < ?` 查询进行全表扫描
- 在大数据集下，删除操作会非常缓慢并锁表

## 解决方案

### 1. 添加数据库索引

**修改文件**: `model/log.go`

在 `LogDetail` 结构体的 `created_at` 字段上添加索引：

```go
CreatedAt int64 `json:"created_at" gorm:"bigint;index;autoCreateTime"`
```

这将使 GORM 在自动迁移时创建索引。

### 2. 数据库迁移脚本

**新增文件**: `bin/add_log_detail_index.sql`

对于现有数据库，运行以下 SQL 添加索引：

```sql
CREATE INDEX IF NOT EXISTS idx_log_details_created_at ON log_details(created_at);
```

支持 MySQL/MariaDB、PostgreSQL 和 SQLite。

### 3. 优化删除策略

**修改文件**: `model/log_retention.go`

改进包括：
- **添加 `ORDER BY created_at ASC`**: 利用索引确保高效的查询执行路径
- **上下文取消检查**: 支持优雅中断清理过程
- **批次间延迟**: 在批次之间添加 100ms 延迟，减少数据库负载高峰

## 性能影响

### 索引添加前：
- 全表扫描，时间复杂度 O(n)
- 大表可能需要数分钟到数小时
- 长时间持有表锁

### 索引添加后：
- 索引查找，时间复杂度 O(log n + k)，k 为结果集大小
- 即使百万级记录，单批次也能在毫秒级完成
- 显著减少锁表时间

## 部署步骤

### 新部署（自动）
新部署会通过 GORM AutoMigrate 自动创建索引。

### 现有部署（需要手动迁移）

1. **备份数据库**（重要！）
   ```bash
   # MySQL
   mysqldump -u user -p database_name > backup.sql
   
   # PostgreSQL
   pg_dump -U user database_name > backup.sql
   ```

2. **创建索引**
   ```bash
   # 连接到数据库并执行
   mysql -u user -p database_name < bin/add_log_detail_index.sql
   
   # 或在数据库客户端中执行
   CREATE INDEX IF NOT EXISTS idx_log_details_created_at ON log_details(created_at);
   ```

3. **验证索引**
   ```sql
   -- MySQL
   SHOW INDEX FROM log_details WHERE Key_name = 'idx_log_details_created_at';
   
   -- PostgreSQL
   SELECT * FROM pg_indexes WHERE tablename = 'log_details' AND indexname = 'idx_log_details_created_at';
   
   -- SQLite
   SELECT * FROM sqlite_master WHERE type = 'index' AND tbl_name = 'log_details';
   ```

4. **部署新代码**
   ```bash
   # 构建并重启服务
   make build
   systemctl restart one-api  # 或您的服务名称
   ```

## 监控建议

部署后监控以下指标：
- 日志清理任务的执行时间
- 数据库查询性能（通过慢查询日志）
- 删除操作的批次数和总删除量

## 注意事项

1. **索引创建时间**: 对于大表（百万级以上记录），创建索引可能需要几分钟时间，期间会锁表
2. **存储空间**: 索引会占用额外的磁盘空间（通常为数据大小的 5-10%）
3. **维护窗口**: 建议在低流量时段执行索引创建操作

## 相关文件

- `model/log.go` - LogDetail 模型定义
- `model/log_retention.go` - 日志保留清理逻辑
- `bin/add_log_detail_index.sql` - 索引迁移脚本

## 参考

- GORM 索引文档: https://gorm.io/docs/indexes.html
- MySQL 索引优化: https://dev.mysql.com/doc/refman/8.0/en/optimization-indexes.html
