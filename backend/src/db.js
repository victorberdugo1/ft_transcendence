'use strict';
const { Pool } = require('pg');

const db = new Pool({
    host:     process.env.DB_HOST     || 'db',
    port:     process.env.DB_PORT     || 5432,
    database: process.env.DB_NAME     || 'transcendence_db',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
});

db.connect()
  .then(client => {
    console.log('[DB] Conectado a PostgreSQL');
    client.release();
  })
  .catch(err => console.error('[DB] Error de conexión:', err.message));

module.exports = db;