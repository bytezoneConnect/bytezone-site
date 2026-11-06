CREATE TABLE takedown_tickets_new (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES users(id),
  encrypted_details TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Submitted', 'Approved', 'Rejected', 'DMCA Sent', 'In Review', 'Removed', 'Failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO takedown_tickets_new (id, customer_id, encrypted_details, status, created_at, updated_at)
SELECT id, customer_id, encrypted_details, status, created_at, updated_at
FROM takedown_tickets;

DROP TABLE takedown_tickets;
ALTER TABLE takedown_tickets_new RENAME TO takedown_tickets;
CREATE INDEX tickets_status_idx ON takedown_tickets(status, created_at);
