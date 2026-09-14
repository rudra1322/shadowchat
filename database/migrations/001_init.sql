-- ShadowChat schema.
--
-- Rooms are ephemeral by design: a room row (and every message under it, via
-- ON DELETE CASCADE) is deleted once the room has been empty past its TTL.
-- Postgres is the durability layer, not an archive -- nothing here is meant to
-- outlive the conversation.

CREATE TABLE IF NOT EXISTS rooms (
  code            CHAR(8) PRIMARY KEY
                  CHECK (code ~ '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The CHECK mirrors lib/roomCode.ts: Crockford base32 without I, L, O, U.
-- A room can therefore never be addressed by an IP-shaped identifier, even if
-- some future code path tried to insert one.

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  room_code   CHAR(8) NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('chat', 'system')),
  username    TEXT,
  author_id   TEXT,
  body        TEXT NOT NULL CHECK (char_length(body) <= 2000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backlog reads are always "newest N in this room", so index in that order.
CREATE INDEX IF NOT EXISTS messages_room_recent_idx
  ON messages (room_code, created_at DESC, id DESC);

-- Boot-time hydration and the sweeper both filter on activity.
CREATE INDEX IF NOT EXISTS rooms_last_active_idx
  ON rooms (last_active_at);
