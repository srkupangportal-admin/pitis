const path = require("path");
const Database = require("better-sqlite3");

const defaultDbPath = path.join(__dirname, "..", "..", "data.db");
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : defaultDbPath;

function createConnection() {
  const instance = new Database(dbPath);
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");
  return instance;
}

let currentDb = createConnection();

const db = new Proxy({}, {
  get(_target, prop) {
    if (prop === Symbol.toStringTag) return "DatabaseProxy";
    const value = currentDb[prop];
    return typeof value === "function" ? value.bind(currentDb) : value;
  },
  set(_target, prop, value) {
    currentDb[prop] = value;
    return true;
  },
  has(_target, prop) {
    return prop in currentDb;
  },
  ownKeys() {
    return Reflect.ownKeys(currentDb);
  },
  getOwnPropertyDescriptor(_target, prop) {
    const descriptor = Object.getOwnPropertyDescriptor(currentDb, prop);
    if (descriptor) return descriptor;
    return {
      configurable: true,
      enumerable: true,
      writable: true,
      value: currentDb[prop]
    };
  }
});

function reloadDatabaseConnection() {
  if (currentDb && currentDb.open) {
    try {
      currentDb.close();
    } catch (_) {}
  }
  currentDb = createConnection();
  return db;
}

function closeDatabaseConnection() {
  if (currentDb && currentDb.open) {
    try {
      currentDb.close();
    } catch (_) {}
  }
}

module.exports = {
  db,
  dbPath,
  reloadDatabaseConnection,
  closeDatabaseConnection
};