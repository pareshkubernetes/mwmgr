-- Metrics table written by workspace-mgr (one row per action, success or failure).
CREATE SCHEMA IF NOT EXISTS metrics;

CREATE TABLE IF NOT EXISTS metrics."devspaces-metrics" (
  id               BIGSERIAL PRIMARY KEY,
  "timestamp"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  csiid            VARCHAR(32),
  soeid            VARCHAR(64),
  eventtype        VARCHAR(32)  NOT NULL,   -- create | delete | start | stop | update | view
  resourcename     VARCHAR(255),
  resourcetype     VARCHAR(64)  NOT NULL,   -- workspace | project | deployment_namespace | pat | gitconfig | configmap ...
  status           JSONB        NOT NULL DEFAULT '{"failed": false, "error": "", "message": ""}',
  limitcpu         NUMERIC(10, 3) NOT NULL DEFAULT 0,
  limitmemory      NUMERIC(12, 3) NOT NULL DEFAULT 0,
  requestcpu       NUMERIC(10, 3) NOT NULL DEFAULT 0,
  requestmemory    NUMERIC(12, 3) NOT NULL DEFAULT 0,
  duration         VARCHAR(64)  NOT NULL DEFAULT '0 seconds',
  storage          NUMERIC(12, 3) NOT NULL DEFAULT 0,
  useraction       VARCHAR(32)  NOT NULL DEFAULT 'user',  -- user | system
  workspaceversion VARCHAR(64)  NOT NULL DEFAULT '',
  editorname       VARCHAR(64)  NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS devspaces_metrics_ts_idx   ON metrics."devspaces-metrics" ("timestamp");
CREATE INDEX IF NOT EXISTS devspaces_metrics_soeid_idx ON metrics."devspaces-metrics" (soeid);
CREATE INDEX IF NOT EXISTS devspaces_metrics_event_idx ON metrics."devspaces-metrics" (eventtype, resourcetype);
