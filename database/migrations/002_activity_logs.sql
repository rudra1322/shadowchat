CREATE TABLE IF NOT EXISTS activity_logs (
  id          BIGSERIAL PRIMARY KEY,
  event       TEXT NOT NULL,
  room_code   CHAR(8),
  username    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT activity_logs_event_check
    CHECK (
      event IN (
        'ROOM_CREATED',
        'USER_JOINED',
        'MESSAGE_SENT',
        'USER_LEFT',
        'ROOM_EXPIRED'
      )
    )
);

CREATE INDEX IF NOT EXISTS activity_logs_created_idx
  ON activity_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS activity_logs_room_idx
  ON activity_logs (room_code, created_at DESC);