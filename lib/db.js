const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function read(filename) {
  ensureDir();
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return []; }
}

function write(filename, data) {
  ensureDir();
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

module.exports = {
  getAgents:       ()     => read('agents.json'),
  getClients:      ()     => read('clients.json'),
  getAgentBySlug:  slug   => read('agents.json').find(a => a.slug === slug)  || null,
  getAgentById:    id     => read('agents.json').find(a => a.id === id)      || null,
  getAgentByEmail: email  => read('agents.json').find(a => a.email === email)|| null,

  addAgent(agent) {
    const agents = read('agents.json');
    agents.push(agent);
    write('agents.json', agents);
    return agent;
  },

  updateAgent(id, updates) {
    const agents = read('agents.json');
    const i = agents.findIndex(a => a.id === id);
    if (i === -1) return null;
    agents[i] = { ...agents[i], ...updates };
    write('agents.json', agents);
    return agents[i];
  },

  getClientsByAgentId: agentId => read('clients.json').filter(c => c.agentId === agentId),
  getClientById:    id    => read('clients.json').find(c => c.id === id)                          || null,
  getClientByEmail: (email, agentId) => read('clients.json').find(c => c.email === email && c.agentId === agentId) || null,

  addClient(client) {
    const clients = read('clients.json');
    clients.push(client);
    write('clients.json', clients);
    return client;
  },

  updateClient(id, updates) {
    const clients = read('clients.json');
    const i = clients.findIndex(c => c.id === id);
    if (i === -1) return null;
    clients[i] = { ...clients[i], ...updates };
    write('clients.json', clients);
    return clients[i];
  }
};
