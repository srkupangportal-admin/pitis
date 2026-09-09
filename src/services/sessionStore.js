const session = require("express-session");

class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_sessions (
        sid TEXT PRIMARY KEY,
        session_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS web_sessions_expires_idx ON web_sessions(expires_at);
    `);
    const cleanup = setInterval(() => {
      try {
        this.db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(Date.now());
      } catch (error) {
        console.error("Session cleanup failed:", error.message);
      }
    }, 60 * 60 * 1000);
    cleanup.unref?.();
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare("SELECT session_json,expires_at FROM web_sessions WHERE sid=?").get(sid);
      if (!row || row.expires_at <= Date.now()) {
        if (row) this.db.prepare("DELETE FROM web_sessions WHERE sid=?").run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.session_json));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expiresAt = value?.cookie?.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      this.db.prepare(`
        INSERT INTO web_sessions(sid,session_json,expires_at) VALUES(?,?,?)
        ON CONFLICT(sid) DO UPDATE SET session_json=excluded.session_json,expires_at=excluded.expires_at
      `).run(sid, JSON.stringify(value), expiresAt);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.db.prepare("DELETE FROM web_sessions WHERE sid=?").run(sid);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, value, callback = () => {}) {
    try {
      const expiresAt = value?.cookie?.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + 24 * 60 * 60 * 1000;
      this.db.prepare("UPDATE web_sessions SET expires_at=? WHERE sid=?").run(expiresAt, sid);
      callback();
    } catch (error) {
      callback(error);
    }
  }
}

module.exports = { SqliteSessionStore };
