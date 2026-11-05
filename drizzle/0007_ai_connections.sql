CREATE TABLE ai_connections (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'openai'),
  cipher_text TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version TEXT NOT NULL,
  last_four TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE ai_model_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  household_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kitchen_revision INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  transcript_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'cancelled')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  output_hash TEXT,
  response_json TEXT,
  response_status INTEGER
);
CREATE INDEX ai_model_tasks_actor ON ai_model_tasks(actor_id, household_id, workflow_id);
CREATE INDEX ai_model_tasks_expiry ON ai_model_tasks(expires_at);
CREATE TRIGGER ai_household_deleted AFTER DELETE ON organization BEGIN
  DELETE FROM ai_model_tasks WHERE household_id = OLD.id;
END;
CREATE TRIGGER ai_user_deleted AFTER DELETE ON user BEGIN
  DELETE FROM ai_connections WHERE user_id = OLD.id;
  DELETE FROM ai_model_tasks WHERE actor_id = OLD.id;
END;
