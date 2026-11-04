CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email_digest TEXT NOT NULL UNIQUE,
  encrypted_profile TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer', 'staff', 'admin')),
  biometric_template TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_digest TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  billing_unit TEXT NOT NULL CHECK (billing_unit IN ('hour', 'day')),
  rate_mwk INTEGER NOT NULL CHECK (rate_mwk >= 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'rented', 'maintenance')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rentals (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  encrypted_customer TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'returned')),
  checked_out_at TEXT NOT NULL,
  expected_return_at TEXT NOT NULL,
  returned_at TEXT,
  rate_mwk INTEGER NOT NULL,
  billing_unit TEXT NOT NULL CHECK (billing_unit IN ('hour', 'day')),
  deposit_mwk INTEGER NOT NULL DEFAULT 0,
  deposit_status TEXT NOT NULL DEFAULT 'held' CHECK (deposit_status IN ('held', 'refunded', 'applied', 'none')),
  total_mwk INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS rental_payments (
  id TEXT PRIMARY KEY,
  rental_id TEXT NOT NULL REFERENCES rentals(id),
  amount_mwk INTEGER NOT NULL CHECK (amount_mwk > 0),
  payment_method TEXT NOT NULL,
  confirmed_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  barcode TEXT UNIQUE,
  price_mwk INTEGER NOT NULL CHECK (price_mwk >= 0),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES users(id),
  items_json TEXT NOT NULL,
  total_mwk INTEGER NOT NULL CHECK (total_mwk >= 0),
  payment_method TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS takedown_tickets (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  encrypted_details TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Submitted', 'DMCA Sent', 'In Review', 'Removed', 'Failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pos_inquiries (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  encrypted_details TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS rentals_status_idx ON rentals(status, expected_return_at);
CREATE INDEX IF NOT EXISTS sales_created_idx ON sales(created_at);
CREATE INDEX IF NOT EXISTS tickets_status_idx ON takedown_tickets(status, created_at);

INSERT OR IGNORE INTO devices (id, name, type, billing_unit, rate_mwk, status, created_at) VALUES
  ('laptop-default', 'Laptop', 'Laptop', 'hour', 6700, 'available', '2026-01-01T00:00:00.000Z'),
  ('desktop-default', 'Desktop PC', 'Desktop PC', 'hour', 4000, 'available', '2026-01-01T00:00:00.000Z'),
  ('gaming-pc-default', 'Gaming PC', 'Gaming PC', 'hour', 5999, 'available', '2026-01-01T00:00:00.000Z'),
  ('ps5-default', 'PS5 Gaming Console', 'PS5 Gaming Console', 'day', 15000, 'available', '2026-01-01T00:00:00.000Z');
