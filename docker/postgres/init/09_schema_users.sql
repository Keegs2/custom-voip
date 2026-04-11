-- Users table for JWT authentication
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'readonly')),
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users USING hash (email);
CREATE INDEX IF NOT EXISTS idx_users_customer ON users(customer_id);
GRANT ALL ON users TO api;
GRANT USAGE, SELECT ON users_id_seq TO api;

-- Seed admin user: admin@customvoip.com / admin123
INSERT INTO users (email, password_hash, customer_id, role, name, status) VALUES
('admin@customvoip.com', '$2b$12$3waCBHwkLKsE33ZqkisqJeEKtRx18REHt8AKTMNBuQwmgjuqXN8xy', NULL, 'admin', 'Platform Admin', 'active')
ON CONFLICT (email) DO NOTHING;

-- Seed UCaaS test user: ucaas@customvoip.com / password123
INSERT INTO users (email, password_hash, customer_id, role, name, status) VALUES
('ucaas@customvoip.com', '$2b$12$3waCBHwkLKsE33ZqkisqJeEKtRx18REHt8AKTMNBuQwmgjuqXN8xy', 5, 'user', 'UCaaS Test User', 'active')
ON CONFLICT (email) DO NOTHING;
