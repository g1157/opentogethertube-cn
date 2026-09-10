CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,
	identity_id TEXT NOT NULL,
	username TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE rooms (
	name TEXT PRIMARY KEY,
	instance_id TEXT NOT NULL,
	owner_id TEXT NOT NULL,
	title TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	visibility TEXT NOT NULL,
	is_temporary INTEGER NOT NULL,
	queue_mode TEXT NOT NULL,
	current_source TEXT,
	user_count INTEGER NOT NULL DEFAULT 0,
	expires_at INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX rooms_owner ON rooms(owner_id);
CREATE INDEX rooms_visibility ON rooms(visibility, expires_at);
CREATE INDEX rooms_expiry ON rooms(expires_at);

CREATE TABLE media_cache (
	cache_key TEXT PRIMARY KEY,
	metadata TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX media_expiry ON media_cache(expires_at);

CREATE TABLE rate_limits (
	limit_key TEXT PRIMARY KEY,
	used INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
