const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('../lib/db');
const { requireAdmin } = require('../lib/auth');

router.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, '..', 'views', 'admin-login.html'));
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {});
  res.redirect('/admin/login');
});

router.get('/', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'admin-dashboard.html'));
});

router.get('/api/stats', requireAdmin, (req, res) => {
  const agents = db.getAgents();
  const clients = db.getClients();
  const now = new Date();
  res.json({
    totalAgents:   agents.length,
    activeAgents:  agents.filter(a => a.status === 'active').length,
    totalClients:  clients.length,
    activeClients: clients.filter(c => c.status === 'active' && new Date(c.subscriptionExpiry) > now).length,
  });
});

router.get('/api/agents', requireAdmin, (req, res) => {
  const agents = db.getAgents();
  const clients = db.getClients();
  res.json(agents.map(a => ({
    ...a,
    password: undefined,
    clientCount: clients.filter(c => c.agentId === a.id).length
  })));
});

router.post('/api/agents', requireAdmin, async (req, res) => {
  try {
    const { name, slug, email, password, whatsapp, plan, planExpiry } = req.body;
    if (!name || !slug || !email || !password)
      return res.status(400).json({ error: 'name, slug, email, password are required' });

    const cleanSlug = slug.toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (db.getAgentBySlug(cleanSlug))
      return res.status(400).json({ error: 'Slug already in use' });
    if (db.getAgentByEmail(email))
      return res.status(400).json({ error: 'Email already registered' });

    const agent = {
      id:          uuidv4(),
      slug:        cleanSlug,
      name,
      logo:        null,
      whatsapp:    whatsapp || '',
      email,
      password:    await bcrypt.hash(password, 10),
      status:      'active',
      plan:        plan || 'yearly',
      planExpiry:  planExpiry || new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0],
      packages:    [],
      hotels:      [],
      createdAt:   new Date().toISOString()
    };

    db.addAgent(agent);
    res.json({ success: true, agent: { ...agent, password: undefined } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/agents/:id/status', requireAdmin, (req, res) => {
  const agent = db.getAgentById(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const newStatus = agent.status === 'active' ? 'inactive' : 'active';
  db.updateAgent(agent.id, { status: newStatus });
  res.json({ success: true, status: newStatus });
});

router.get('/api/clients', requireAdmin, (req, res) => {
  const clients = db.getClients();
  const agents  = db.getAgents();
  res.json(clients.map(c => ({
    ...c,
    password:  undefined,
    agentName: (agents.find(a => a.id === c.agentId) || {}).name || 'Unknown'
  })));
});

module.exports = router;
