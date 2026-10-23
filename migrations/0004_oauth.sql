-- OAuth 2.1 server storage for the MCP connector (Claude as the client). Tokens and codes are
-- stored only as SHA-256 hex; the secrets themselves are never persisted.
--
-- Portability notes (Postgres version later): ids are UUID v7 text (→ uuid), timestamps are
-- ISO-8601 UTC text (→ timestamptz), redirect_uris is a JSON array in text (→ jsonb).
-- STRICT is SQLite-only.

CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,                           -- JSON array of strings
  created_at    TEXT NOT NULL
) STRICT;

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,                       -- SHA-256 of the authorization code
  client_id      TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,                          -- PKCE S256
  resource       TEXT NOT NULL,
  user_agent     TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  consumed_at    TEXT
) STRICT;

CREATE TABLE oauth_connections (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT
) STRICT;

CREATE INDEX idx_oauth_connections_user ON oauth_connections(user_id);
CREATE INDEX idx_oauth_connections_expires ON oauth_connections(expires_at);

CREATE TABLE oauth_tokens (
  token_hash    TEXT PRIMARY KEY,                        -- SHA-256 of the access/refresh token
  connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at    TEXT NOT NULL,
  rotated_at    TEXT
) STRICT;

CREATE INDEX idx_oauth_tokens_connection ON oauth_tokens(connection_id);
CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at);
