const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { databasePoolOptions } = require("../lib/api/db-ssl");

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({
    ...databasePoolOptions(connectionString),
  });
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const migrationsDir = path.join(__dirname, "migrations");
    const files = fs.readdirSync(migrationsDir).filter(name => name.endsWith(".sql")).sort();
    for (const file of files) {
      const existing = await client.query("select 1 from schema_migrations where name = $1", [file]);
      if (existing.rowCount) {
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations(name) values($1)", [file]);
        await client.query("commit");
        // eslint-disable-next-line no-console
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(error => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
