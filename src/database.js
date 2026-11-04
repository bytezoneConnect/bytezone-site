const fs = require("node:fs");
const path = require("node:path");
const initSqlJs = require("sql.js");

const databasePath = path.resolve(process.env.BYTEZONE_DATABASE_PATH || "./data/bytezone.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });

let database;
let transactionDepth = 0;
const ready = initSqlJs({ locateFile: (file) => require.resolve(`sql.js/dist/${file}`) }).then((SQL) => {
  const saved = fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : null;
  database = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();
  database.run("PRAGMA foreign_keys = ON");
});

function persist() {
  const temporaryPath = `${databasePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, Buffer.from(database.export()), { mode: 0o600 });
  fs.renameSync(temporaryPath, databasePath);
}

function statement(sql) {
  return {
    all(...parameters) {
      const prepared = database.prepare(sql);
      try {
        if (parameters.length) prepared.bind(parameters);
        const rows = [];
        while (prepared.step()) rows.push(prepared.getAsObject());
        return rows;
      } finally {
        prepared.free();
      }
    },
    get(...parameters) {
      return this.all(...parameters)[0];
    },
    run(...parameters) {
      try {
        database.run(sql, parameters);
      } catch (error) {
        if (/UNIQUE constraint failed/i.test(error.message)) error.code = "SQLITE_CONSTRAINT_UNIQUE";
        throw error;
      }
      const changes = database.getRowsModified();
      const lastInsertRowid = database.exec("SELECT last_insert_rowid() AS id")[0]?.values[0][0];
      if (transactionDepth === 0) persist();
      return { changes, lastInsertRowid };
    },
  };
}

const db = {
  exec(sql) {
    database.exec(sql);
    if (transactionDepth === 0) persist();
  },
  prepare: statement,
  transaction(callback) {
    return (...args) => {
      database.run("BEGIN");
      transactionDepth += 1;
      let result;
      try {
        result = callback(...args);
        database.run("COMMIT");
        transactionDepth -= 1;
      } catch (error) {
        if (transactionDepth > 0) {
          database.run("ROLLBACK");
          transactionDepth -= 1;
        }
        throw error;
      }
      if (transactionDepth === 0) persist();
      return result;
    };
  },
  async ready() {
    await ready;
  },
};

async function migrate() {
  await ready;
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const migrationDirectory = path.resolve(__dirname, "..", "migrations");
  const applied = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((row) => row.name));
  const files = fs.readdirSync(migrationDirectory).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationDirectory, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
    })();
  }
}

module.exports = { db, migrate };
