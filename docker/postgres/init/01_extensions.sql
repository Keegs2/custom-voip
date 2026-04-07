-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- Query performance monitoring
CREATE EXTENSION IF NOT EXISTS btree_gin;           -- For composite GIN indexes

-- Create additional users for service isolation
CREATE USER freeswitch WITH PASSWORD 'fs_secret';
CREATE USER api WITH PASSWORD 'api_secret';

-- Performance settings - reduced for Docker Desktop testing
-- Note: TimescaleDB image already has shared_preload_libraries configured
ALTER SYSTEM SET max_connections = 100;
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET effective_cache_size = '512MB';
ALTER SYSTEM SET maintenance_work_mem = '64MB';
ALTER SYSTEM SET checkpoint_completion_target = 0.9;
ALTER SYSTEM SET wal_buffers = '16MB';
ALTER SYSTEM SET work_mem = '4MB';
ALTER SYSTEM SET random_page_cost = 1.1;

-- Statement timeout to prevent runaway queries
ALTER SYSTEM SET statement_timeout = '30s';
