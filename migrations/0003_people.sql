-- People you split bills with (names only, not accounts) and each person's share of an expense.
-- Rule kept by the service: when an expense has shares, my_share + SUM(shares.amount) = paid.
-- Older split expenses have no shares; their paid - my_share shows up as "unassigned".

-- Target of the composite FK below (SQLite can't add a UNIQUE constraint to an existing table;
-- a unique index serves the same purpose, and Postgres accepts it too).
CREATE UNIQUE INDEX idx_expenses_id_user ON expenses(id, user_id);

CREATE TABLE people (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  name_key   TEXT NOT NULL,                              -- lowercased name: "Ravi" == "ravi"
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name_key),
  UNIQUE (id, user_id)
) STRICT;

CREATE TABLE expense_shares (
  expense_id TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  amount     INTEGER NOT NULL CHECK (amount > 0 AND amount <= 100000000),   -- paise
  PRIMARY KEY (expense_id, person_id),
  -- both sides must belong to the same user; deleting either removes the share
  FOREIGN KEY (expense_id, user_id) REFERENCES expenses(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (person_id, user_id) REFERENCES people(id, user_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX idx_expense_shares_person ON expense_shares(person_id, user_id);
