-- Out-of-app release notifications. Secrets (webhook URLs, bot tokens, SMTP
-- passwords, signing keys) are sealed with the instance service key so the
-- background checker can deliver while the vault is locked.
CREATE TABLE notification_channels (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('webhook','wecom','dingtalk','feishu','telegram','email')),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',
  secret bytea,
  last_sent_at timestamptz,
  last_status text NOT NULL DEFAULT 'never',
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
