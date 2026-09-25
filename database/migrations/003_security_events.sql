CREATE TABLE IF NOT EXISTS security_events (
  id          BIGSERIAL PRIMARY KEY,
  event       TEXT NOT NULL,
  room_code   CHAR(8),
  username    TEXT,
  ip_key      TEXT,
  details     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT security_events_event_check
    CHECK (
      event IN (
        'JOIN_RATE_LIMITED',
        'MESSAGE_RATE_LIMITED',
        'INVALID_ROOM_CODE',
        'PERSISTENCE_FAILURE',
        'CONNECTION_ERROR',
        'SERVER_ERROR'
      )
    )
);

CREATE INDEX IF NOT EXISTS security_events_created_idx
  ON security_events (created_at DESC);

CREATE INDEX IF NOT EXISTS security_events_event_idx
  ON security_events (event, created_at DESC);

CREATE INDEX IF NOT EXISTS security_events_room_idx
  ON security_events (room_code, created_at DESC);