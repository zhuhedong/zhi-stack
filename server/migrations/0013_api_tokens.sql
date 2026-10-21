-- Personal API tokens. Only the SHA-256 of the token is stored.
CREATE TABLE api_tokens (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
