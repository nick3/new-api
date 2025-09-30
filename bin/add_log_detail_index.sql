-- Migration: Add index on log_details.created_at for efficient retention cleanup
-- Date: 2025-09-30
-- Purpose: Optimize the log detail retention cleanup process by adding an index
--          on the created_at column to avoid full table scans during deletion.

-- Check if index exists before creating (for MySQL/MariaDB)
-- For existing databases, run this migration to add the index:

CREATE INDEX IF NOT EXISTS idx_log_details_created_at ON log_details(created_at);

-- For PostgreSQL, use:
-- CREATE INDEX IF NOT EXISTS idx_log_details_created_at ON log_details(created_at);

-- For SQLite:
-- CREATE INDEX IF NOT EXISTS idx_log_details_created_at ON log_details(created_at);

-- Verify the index was created:
-- MySQL: SHOW INDEX FROM log_details WHERE Key_name = 'idx_log_details_created_at';
-- PostgreSQL: SELECT * FROM pg_indexes WHERE tablename = 'log_details' AND indexname = 'idx_log_details_created_at';
-- SQLite: SELECT * FROM sqlite_master WHERE type = 'index' AND tbl_name = 'log_details' AND name = 'idx_log_details_created_at';
