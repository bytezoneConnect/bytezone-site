CREATE TABLE IF NOT EXISTS public_inquiries (
  id TEXT PRIMARY KEY,
  encrypted_details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
