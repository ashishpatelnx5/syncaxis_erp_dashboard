require('dotenv').config();
const sql = require('mssql');

// Connects using the SQL Server Browser service to resolve the named instance
// (SQLEXPRESS), same as SSMS does with "192.168.3.9\SQLEXPRESS".
// This relies on: TCP/IP enabled, SQL Server Browser running, and the firewall
// rules you already set up earlier for remote SSMS access.
const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false, // internal LAN, not Azure — set true only if you configure TLS
    trustServerCertificate: true,
    instanceName: process.env.DB_INSTANCE,
    enableArithAbort: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  },
  requestTimeout: 30000
};

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        console.log(`Connected to SQL Server: ${config.server}\\${config.options.instanceName} / ${config.database}`);
        return pool;
      })
      .catch((err) => {
        console.error('DB connection failed:', err.message);
        poolPromise = null; // allow a retry on the next request instead of staying broken forever
        throw err;
      });
  }
  return poolPromise;
}

module.exports = { sql, getPool };
