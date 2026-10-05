const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const { databasePoolOptions } = require("./db-ssl");

if (!global.__threadbornPool) {
  global.__threadbornPool = new Pool({
    ...databasePoolOptions(process.env.DATABASE_URL),
    max: 1,
  });
}

if (!global.__threadbornMigrationsPromise) {
  global.__threadbornMigrationsPromise = null;
}

async function runMigrationsOnce() {
  if (global.__threadbornMigrationsPromise) {
    return global.__threadbornMigrationsPromise;
  }
  global.__threadbornMigrationsPromise = (async () => {
    const pool = global.__threadbornPool;
    const client = await pool.connect();
    try {
      await client.query(`
        create table if not exists schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);

      const migrationsDir = path.join(process.cwd(), "db", "migrations");
      const files = fs.existsSync(migrationsDir)
        ? fs
            .readdirSync(migrationsDir)
            .filter((name) => name.endsWith(".sql"))
            .sort()
        : [];

      for (const file of files) {
        const exists = await client.query(
          "select 1 from schema_migrations where name = $1",
          [file],
        );
        if (exists.rowCount) {
          continue;
        }
        const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
        await client.query("begin");
        try {
          await client.query(sql);
          await client.query("insert into schema_migrations(name) values($1)", [
            file,
          ]);
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }
    } finally {
      client.release();
    }
  })().catch((err) => {
    global.__threadbornMigrationsPromise = null;
    throw err;
  });
  return global.__threadbornMigrationsPromise;
}

global.__threadbornPool.on("connect", () => {
  runMigrationsOnce().catch((err) =>
    console.error("[db] Migration error on connect:", err),
  );
});

global.__threadbornPool.ensureMigrations = runMigrationsOnce;

module.exports = global.__threadbornPool;
