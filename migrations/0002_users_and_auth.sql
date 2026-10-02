-- Multi-user schema with app-level auth. Replaces the single-user tables from 0001
-- (production had no expenses when this was written).
--
-- Portability notes (Postgres version later): ids are UUID v7 text (→ uuid), timestamps are
-- ISO-8601 UTC text (→ timestamptz), money is integer paise (→ bigint), spent_on stays
-- 'YYYY-MM-DD' text, booleans are 0/1 integers (→ smallint). STRICT is SQLite-only.

DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS categories;

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,                       -- stored lowercased
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  name_key   TEXT NOT NULL,                              -- lowercased name: "Food" == "food"
  icon       TEXT NOT NULL,
  color      TEXT NOT NULL,
  locked     INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),   -- "Other": cannot be deleted
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name_key),
  UNIQUE (id, user_id)                                   -- target of the composite FK below
) STRICT;

CREATE TABLE expenses (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  paid        INTEGER NOT NULL CHECK (paid > 0 AND paid <= 100000000),   -- paise; ₹10 lakh cap
  my_share    INTEGER NOT NULL CHECK (my_share >= 0 AND my_share <= paid),
  note        TEXT CHECK (note IS NULL OR length(note) <= 200),
  spent_on    TEXT NOT NULL CHECK (length(spent_on) = 10),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- an expense can only point at a category owned by the same user
  FOREIGN KEY (category_id, user_id) REFERENCES categories(id, user_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_expenses_user_date ON expenses(user_id, spent_on);
CREATE INDEX idx_expenses_user_category ON expenses(user_id, category_id, spent_on);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,                         -- SHA-256 of the cookie token; the token itself is never stored
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT
) STRICT;

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE auth_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,                             -- HMAC-SHA256(secret, email:code); never the code
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
) STRICT;

CREATE INDEX idx_auth_codes_email ON auth_codes(email, created_at);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count        INTEGER NOT NULL
) STRICT;
