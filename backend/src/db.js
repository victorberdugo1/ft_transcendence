'use strict';

const { Pool } = require('pg');

const db = new Pool({
    host:     process.env.PGHOST     || 'db',
    port:     process.env.PGPORT     || 5432,
    database: process.env.PGDATABASE || 'transcendence',
    user:     process.env.PGUSER     || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
});

module.exports = db;
