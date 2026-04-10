-- CDR Schema with TimescaleDB Hypertable for High-Volume Performance
-- Hypertables automatically partition by time for optimal query performance

CREATE TABLE cdrs (
    id BIGSERIAL,
    uuid VARCHAR(64) NOT NULL,
    customer_id INT NOT NULL,
    product_type VARCHAR(10) NOT NULL,
    trunk_id INT,
    direction VARCHAR(10) NOT NULL,
    caller_id VARCHAR(30),
    destination VARCHAR(30) NOT NULL,
    destination_prefix VARCHAR(20),  -- For rate lookup caching

    -- Timestamps
    start_time TIMESTAMPTZ NOT NULL,
    answer_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ NOT NULL,

    -- Duration
    duration_ms INT NOT NULL DEFAULT 0,
    billable_ms INT NOT NULL DEFAULT 0,

    -- Billing
    rate_per_min DECIMAL(10,6),
    total_cost DECIMAL(12,6) DEFAULT 0,
    carrier_cost DECIMAL(12,6) DEFAULT 0,
    margin DECIMAL(12,6) DEFAULT 0,
    rated_at TIMESTAMPTZ,

    -- Call details
    hangup_cause VARCHAR(50),
    sip_code INT,
    carrier_used VARCHAR(50),
    traffic_grade VARCHAR(10),

    -- Fraud tracking
    fraud_score SMALLINT DEFAULT 0,
    fraud_flags JSONB,

    -- For debugging
    freeswitch_node VARCHAR(50),

    -- RTP quality metrics
    mos NUMERIC(3,2),
    quality_pct NUMERIC(5,2),
    jitter_min_ms NUMERIC(8,3),
    jitter_max_ms NUMERIC(8,3),
    jitter_avg_ms NUMERIC(8,3),
    packet_loss_count INTEGER,
    packet_total_count INTEGER,
    packet_loss_pct NUMERIC(5,2),
    flaw_total INTEGER,
    r_factor NUMERIC(5,2),
    rtp_audio_in_raw_bytes BIGINT,
    rtp_audio_in_media_bytes BIGINT,
    rtp_audio_out_raw_bytes BIGINT,
    rtp_audio_out_media_bytes BIGINT,
    rtp_audio_in_packet_count INTEGER,
    rtp_audio_out_packet_count INTEGER,
    rtp_audio_in_jitter_burst_rate NUMERIC(8,4),
    rtp_audio_in_jitter_loss_rate NUMERIC(8,4),
    rtp_audio_in_mean_interval NUMERIC(8,3),
    read_codec VARCHAR(20),
    write_codec VARCHAR(20),

    PRIMARY KEY (id, start_time)
);

-- Convert to TimescaleDB hypertable - CRITICAL for performance
-- Partitions by week, which balances write performance and query efficiency
SELECT create_hypertable('cdrs', 'start_time',
    chunk_time_interval => INTERVAL '1 week',
    if_not_exists => TRUE
);

-- Compression policy - compress chunks older than 1 day
ALTER TABLE cdrs SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'customer_id',
    timescaledb.compress_orderby = 'start_time DESC'
);

SELECT add_compression_policy('cdrs', INTERVAL '1 day', if_not_exists => TRUE);

-- Retention policy - keep detailed CDRs for 90 days, then aggregate
SELECT add_retention_policy('cdrs', INTERVAL '90 days', if_not_exists => TRUE);

-- Indexes optimized for common queries
CREATE INDEX idx_cdrs_customer_time ON cdrs(customer_id, start_time DESC);
CREATE INDEX idx_cdrs_uuid ON cdrs(uuid);
CREATE INDEX idx_cdrs_destination ON cdrs(destination, start_time DESC);
CREATE INDEX idx_cdrs_trunk ON cdrs(trunk_id, start_time DESC) WHERE trunk_id IS NOT NULL;
CREATE INDEX idx_cdrs_unrated ON cdrs(start_time) WHERE rated_at IS NULL;

-- Aggregated CDR stats for dashboards (updated continuously)
CREATE TABLE cdr_daily_stats (
    customer_id INT NOT NULL,
    date DATE NOT NULL,
    product_type VARCHAR(10) NOT NULL,
    direction VARCHAR(10) NOT NULL,
    total_calls INT DEFAULT 0,
    answered_calls INT DEFAULT 0,
    total_duration_sec INT DEFAULT 0,
    total_cost DECIMAL(12,4) DEFAULT 0,
    asr DECIMAL(5,2),  -- Answer Seizure Ratio
    acd INT,           -- Average Call Duration (seconds)
    PRIMARY KEY (customer_id, date, product_type, direction)
);

-- Continuous aggregate for real-time stats
CREATE MATERIALIZED VIEW cdr_hourly_stats
WITH (timescaledb.continuous) AS
SELECT
    customer_id,
    time_bucket('1 hour', start_time) AS hour,
    product_type,
    direction,
    COUNT(*) as total_calls,
    COUNT(*) FILTER (WHERE answer_time IS NOT NULL) as answered_calls,
    SUM(duration_ms) / 1000 as total_duration_sec,
    SUM(total_cost) as total_cost,
    AVG(duration_ms) FILTER (WHERE answer_time IS NOT NULL) / 1000 as avg_duration_sec
FROM cdrs
GROUP BY customer_id, hour, product_type, direction
WITH NO DATA;

-- Refresh policy for continuous aggregate
SELECT add_continuous_aggregate_policy('cdr_hourly_stats',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE
);

-- Function for efficient rate lookup (longest prefix match)
CREATE OR REPLACE FUNCTION get_rate(p_rate_table_id INT, p_destination VARCHAR)
RETURNS TABLE(rate_per_min DECIMAL, cost_per_min DECIMAL, connection_fee DECIMAL, min_duration INT, increment INT, prefix VARCHAR)
LANGUAGE SQL STABLE
AS $$
    SELECT r.rate_per_min, r.cost_per_min, r.connection_fee, r.min_duration, r.increment, r.prefix
    FROM rates r
    WHERE r.rate_table_id = p_rate_table_id
      AND p_destination LIKE r.prefix || '%'
    ORDER BY LENGTH(r.prefix) DESC
    LIMIT 1;
$$;

-- Function for rating a CDR
CREATE OR REPLACE FUNCTION rate_cdr(p_uuid VARCHAR(64))
RETURNS DECIMAL
LANGUAGE plpgsql
AS $$
DECLARE
    v_customer_id INT;
    v_direction VARCHAR;
    v_destination VARCHAR;
    v_duration_ms INT;
    v_rate_table_id INT;
    v_rate DECIMAL;
    v_cost DECIMAL;
    v_carrier_cost DECIMAL;
    v_connection_fee DECIMAL;
    v_min_duration INT;
    v_increment INT;
    v_billable_ms INT;
    v_total_cost DECIMAL;
BEGIN
    -- Get CDR details
    SELECT customer_id, direction, destination, duration_ms
    INTO v_customer_id, v_direction, v_destination, v_duration_ms
    FROM cdrs WHERE uuid = p_uuid AND rated_at IS NULL;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Get rate table
    SELECT CASE WHEN v_direction = 'inbound' THEN inbound_rate_table_id ELSE outbound_rate_table_id END
    INTO v_rate_table_id
    FROM customer_rate_assignments WHERE customer_id = v_customer_id;

    -- Default rate table if not assigned
    v_rate_table_id := COALESCE(v_rate_table_id, 1);

    -- Get rate
    SELECT rate_per_min, cost_per_min, connection_fee, min_duration, increment
    INTO v_rate, v_cost, v_connection_fee, v_min_duration, v_increment
    FROM get_rate(v_rate_table_id, v_destination);

    -- Default rate if no match
    v_rate := COALESCE(v_rate, 0.01);
    v_connection_fee := COALESCE(v_connection_fee, 0);
    v_min_duration := COALESCE(v_min_duration, 0) * 1000;  -- Convert to ms
    v_increment := COALESCE(v_increment, 6) * 1000;        -- Convert to ms

    -- Calculate billable duration
    v_billable_ms := GREATEST(v_duration_ms, v_min_duration);
    v_billable_ms := CEIL(v_billable_ms::DECIMAL / v_increment) * v_increment;

    -- Calculate cost
    v_total_cost := v_connection_fee + (v_billable_ms / 60000.0 * v_rate);

    -- Calculate carrier cost and margin
    v_carrier_cost := v_billable_ms / 60000.0 * COALESCE(v_cost, 0);

    -- Update CDR
    UPDATE cdrs
    SET billable_ms = v_billable_ms,
        rate_per_min = v_rate,
        total_cost = v_total_cost,
        carrier_cost = v_carrier_cost,
        margin = v_total_cost - v_carrier_cost,
        rated_at = NOW()
    WHERE uuid = p_uuid;

    -- Update customer balance
    UPDATE customers
    SET balance = balance - v_total_cost
    WHERE id = v_customer_id;

    RETURN v_total_cost;
END;
$$;

-- Grant permissions
GRANT SELECT, INSERT ON cdrs TO freeswitch;
GRANT ALL ON cdrs, cdr_daily_stats TO api;
GRANT SELECT ON cdr_hourly_stats TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO freeswitch;
GRANT EXECUTE ON FUNCTION get_rate TO freeswitch, api;
GRANT EXECUTE ON FUNCTION rate_cdr TO api;
