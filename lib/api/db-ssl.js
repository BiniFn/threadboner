function databasePoolOptions(connectionString) {
  const production = process.env.NODE_ENV === "production";
  let hostname = "";
  let safeConnectionString = connectionString;
  try {
    const parsed = new URL(connectionString);
    hostname = parsed.hostname.toLowerCase();
    // node-postgres gives SSL options in a connection URL precedence over
    // the explicit `ssl` object. Strip them so `sslmode=no-verify` cannot
    // silently disable certificate validation in deployed environments.
    for (const key of [
      "sslmode",
      "sslrootcert",
      "sslcert",
      "sslkey",
      "sslpassword",
      "uselibpqcompat",
    ]) {
      parsed.searchParams.delete(key);
    }
    safeConnectionString = parsed.toString();
  } catch {
    // Let node-postgres report malformed connection strings when it connects.
  }

  const localHost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  if (!production && (localHost || process.env.DATABASE_SSL === "disable")) {
    return { connectionString: safeConnectionString, ssl: false };
  }

  const ssl = { rejectUnauthorized: true };
  const ca = process.env.DATABASE_SSL_CA?.trim();
  if (ca) ssl.ca = ca.replace(/\\n/g, "\n");
  return { connectionString: safeConnectionString, ssl };
}

module.exports = { databasePoolOptions };
