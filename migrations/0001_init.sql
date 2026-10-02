-- STRICT tables: SQLite otherwise stores 100.5 or 'abc' in an INTEGER column
-- (and 'abc' > 0 passes a CHECK). Money is integer paise.

CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name) BETWEEN 1 AND 40),
  icon       TEXT    NOT NULL DEFAULT 'tag',
  color      TEXT    NOT NULL DEFAULT 'slate',
  locked     INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),   -- "Other": cannot be deleted
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE expenses (
  id          INTEGER PRIMARY KEY,
  paid        INTEGER NOT NULL CHECK (paid > 0 AND paid <= 100000000),          -- ₹10 lakh cap
  my_share    INTEGER NOT NULL CHECK (my_share >= 0 AND my_share <= paid),
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  note        TEXT    CHECK (note IS NULL OR length(note) <= 200),
  spent_on    TEXT    NOT NULL CHECK (spent_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_expenses_spent_on ON expenses(spent_on);
CREATE INDEX idx_expenses_category ON expenses(category_id, spent_on);

INSERT INTO categories (name, icon, color, locked) VALUES
  ('Food',          'utensils',      'orange', 0),
  ('Groceries',     'shopping-cart', 'green',  0),
  ('Travel',        'train-front',   'blue',   0),
  ('Shopping',      'shopping-bag',  'teal',   0),
  ('Bills',         'receipt',       'amber',  0),
  ('Entertainment', 'clapperboard',  'pink',   0),
  ('Health',        'pill',          'red',    0),
  ('Other',         'tag',           'slate',  1);
