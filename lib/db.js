const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// ── Row → JS object (snake_case → camelCase) ───────────────────
function toAgent(row) {
  if (!row) return null;
  return {
    id:         row.id,
    slug:       row.slug,
    name:       row.name,
    logo:       row.logo,
    whatsapp:   row.whatsapp,
    email:      row.email,
    password:   row.password,
    status:     row.status,
    plan:       row.plan,
    planExpiry: row.plan_expiry ? String(row.plan_expiry).split('T')[0] : null,
    packages:   row.packages  || [],
    hotels:     row.hotels    || [],
    createdAt:  row.created_at ? row.created_at.toISOString() : null
  };
}

function toClient(row) {
  if (!row) return null;
  return {
    id:                 row.id,
    agentId:            row.agent_id,
    name:               row.name,
    email:              row.email,
    password:           row.password,
    status:             row.status,
    subscriptionExpiry: row.subscription_expiry ? String(row.subscription_expiry).split('T')[0] : null,
    stripeCustomerId:   row.stripe_customer_id,
    createdAt:          row.created_at ? row.created_at.toISOString() : null
  };
}

// camelCase → snake_case column map for dynamic UPDATE queries
const AGENT_COL = {
  name: 'name', logo: 'logo', whatsapp: 'whatsapp',
  email: 'email', password: 'password', status: 'status',
  plan: 'plan', planExpiry: 'plan_expiry',
  packages: 'packages', hotels: 'hotels'
};

const CLIENT_COL = {
  name: 'name', email: 'email', password: 'password', status: 'status',
  subscriptionExpiry: 'subscription_expiry', stripeCustomerId: 'stripe_customer_id'
};

// ── Schema init ────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id          TEXT PRIMARY KEY,
      slug        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      logo        TEXT,
      whatsapp    TEXT DEFAULT '',
      email       TEXT UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      status      TEXT DEFAULT 'active',
      plan        TEXT DEFAULT 'yearly',
      plan_expiry DATE,
      packages    JSONB DEFAULT '[]',
      hotels      JSONB DEFAULT '[]',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clients (
      id                  TEXT PRIMARY KEY,
      agent_id            TEXT REFERENCES agents(id),
      name                TEXT NOT NULL,
      email               TEXT NOT NULL,
      password            TEXT NOT NULL,
      status              TEXT DEFAULT 'active',
      subscription_expiry DATE,
      stripe_customer_id  TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(email, agent_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid    TEXT PRIMARY KEY,
      sess   JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
  `);
  console.log('Database schema ready.');
}

// ── Agents ─────────────────────────────────────────────────────
async function getAgents() {
  const { rows } = await pool.query('SELECT * FROM agents ORDER BY created_at DESC');
  return rows.map(toAgent);
}

async function getAgentBySlug(slug) {
  const { rows } = await pool.query('SELECT * FROM agents WHERE slug = $1', [slug]);
  return toAgent(rows[0]);
}

async function getAgentById(id) {
  const { rows } = await pool.query('SELECT * FROM agents WHERE id = $1', [id]);
  return toAgent(rows[0]);
}

async function getAgentByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM agents WHERE email = $1', [email]);
  return toAgent(rows[0]);
}

async function addAgent(agent) {
  const { rows } = await pool.query(
    `INSERT INTO agents (id, slug, name, logo, whatsapp, email, password, status, plan, plan_expiry, packages, hotels)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
     RETURNING *`,
    [
      agent.id, agent.slug, agent.name, agent.logo || null,
      agent.whatsapp || '', agent.email, agent.password,
      agent.status || 'active', agent.plan || 'yearly',
      agent.planExpiry || null,
      JSON.stringify(agent.packages || []),
      JSON.stringify(agent.hotels   || [])
    ]
  );
  return toAgent(rows[0]);
}

async function updateAgent(id, updates) {
  const cols = [], vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(updates)) {
    const col = AGENT_COL[k];
    if (!col) continue;
    cols.push(`${col} = $${i++}`);
    vals.push((k === 'packages' || k === 'hotels') && typeof v === 'object'
      ? JSON.stringify(v) : v);
  }
  if (!cols.length) return null;
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE agents SET ${cols.join(', ')} WHERE id = $${i} RETURNING *`, vals
  );
  return toAgent(rows[0]);
}

// ── Clients ────────────────────────────────────────────────────
async function getClients() {
  const { rows } = await pool.query('SELECT * FROM clients ORDER BY created_at DESC');
  return rows.map(toClient);
}

async function getClientsByAgentId(agentId) {
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE agent_id = $1 ORDER BY created_at DESC', [agentId]
  );
  return rows.map(toClient);
}

async function getClientById(id) {
  const { rows } = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
  return toClient(rows[0]);
}

async function getClientByEmail(email, agentId) {
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE email = $1 AND agent_id = $2', [email, agentId]
  );
  return toClient(rows[0]);
}

async function addClient(client) {
  const { rows } = await pool.query(
    `INSERT INTO clients (id, agent_id, name, email, password, status, subscription_expiry, stripe_customer_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      client.id, client.agentId, client.name, client.email,
      client.password, client.status || 'active',
      client.subscriptionExpiry || null,
      client.stripeCustomerId   || null
    ]
  );
  return toClient(rows[0]);
}

async function updateClient(id, updates) {
  const cols = [], vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(updates)) {
    const col = CLIENT_COL[k];
    if (!col) continue;
    cols.push(`${col} = $${i++}`);
    vals.push(v);
  }
  if (!cols.length) return null;
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE clients SET ${cols.join(', ')} WHERE id = $${i} RETURNING *`, vals
  );
  return toClient(rows[0]);
}

module.exports = {
  pool, initDB,
  getAgents, getAgentBySlug, getAgentById, getAgentByEmail, addAgent, updateAgent,
  getClients, getClientsByAgentId, getClientById, getClientByEmail, addClient, updateClient
};
