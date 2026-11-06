ALTER TABLE users ADD COLUMN google_sub_digest TEXT;

CREATE UNIQUE INDEX users_google_sub_digest_unique_idx
  ON users(google_sub_digest)
  WHERE google_sub_digest IS NOT NULL;