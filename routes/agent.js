const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../lib/db');
const { requireAgent } = require('../lib/auth');

const LOGOS_DIR = path.join(__dirname, '..', 'public', 'logos');
if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, LOGOS_DIR),
    filename:    (req, file, cb) => cb(null, `${req.session.agentId}${path.extname(file.originalname)}`)
  }),
  limits:     { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'))
});

// ── Auth ───────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session && req.session.agentId) return res.redirect('/agent/dashboard');
  res.sendFile(path.join(__dirname, '..', 'views', 'agent-login.html'));
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const agent = db.getAgentByEmail(email);
  if (!agent) return res.status(401).json({ error: 'Invalid credentials' });
  if (agent.status !== 'active') return res.status(403).json({ error: 'Account inactive — contact support' });
  if (!await bcrypt.compare(password, agent.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  req.session.agentId = agent.id;
  res.json({ success: true });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {});
  res.redirect('/agent/login');
});

router.get('/dashboard', requireAgent, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'agent-dashboard.html'));
});

// ── Profile ────────────────────────────────────────────────────
router.get('/api/me', requireAgent, (req, res) => {
  const agent = db.getAgentById(req.session.agentId);
  if (!agent) return res.status(404).json({ error: 'Not found' });
  res.json({ ...agent, password: undefined });
});

router.patch('/api/me', requireAgent, (req, res) => {
  const { whatsapp, name } = req.body;
  const updates = {};
  if (whatsapp !== undefined) updates.whatsapp = whatsapp;
  if (name     !== undefined) updates.name     = name;
  db.updateAgent(req.session.agentId, updates);
  res.json({ success: true });
});

router.post('/api/logo', requireAgent, upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const logo = `/logos/${req.file.filename}`;
  db.updateAgent(req.session.agentId, { logo });
  res.json({ success: true, logo });
});

// ── Stats ──────────────────────────────────────────────────────
router.get('/api/stats', requireAgent, (req, res) => {
  const clients   = db.getClientsByAgentId(req.session.agentId);
  const now       = new Date();
  const sevenDays = new Date(Date.now() + 7*24*60*60*1000);
  res.json({
    total:        clients.length,
    active:       clients.filter(c => c.status === 'active' && new Date(c.subscriptionExpiry) > now).length,
    expiringSoon: clients.filter(c => {
      const exp = new Date(c.subscriptionExpiry);
      return c.status === 'active' && exp > now && exp <= sevenDays;
    }).length,
    expired: clients.filter(c => new Date(c.subscriptionExpiry) <= now).length
  });
});

// ── Clients ────────────────────────────────────────────────────
router.get('/api/clients', requireAgent, (req, res) => {
  const clients = db.getClientsByAgentId(req.session.agentId);
  res.json(clients.map(c => ({ ...c, password: undefined })));
});

router.post('/api/clients', requireAgent, async (req, res) => {
  try {
    const { name, email, days = 30 } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
    if (db.getClientByEmail(email, req.session.agentId))
      return res.status(400).json({ error: 'Email already registered for this agent' });

    const tempPassword = Math.random().toString(36).slice(-8);
    const expiry = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000);

    const client = {
      id:                 uuidv4(),
      agentId:            req.session.agentId,
      name,
      email,
      password:           await bcrypt.hash(tempPassword, 10),
      status:             'active',
      subscriptionExpiry: expiry.toISOString().split('T')[0],
      stripeCustomerId:   null,
      createdAt:          new Date().toISOString()
    };

    db.addClient(client);
    res.json({ success: true, client: { ...client, password: undefined }, tempPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/clients/:id/status', requireAgent, (req, res) => {
  const client = db.getClientsByAgentId(req.session.agentId).find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const newStatus = client.status === 'active' ? 'inactive' : 'active';
  db.updateClient(client.id, { status: newStatus });
  res.json({ success: true, status: newStatus });
});

// ── Inventory ──────────────────────────────────────────────────
router.get('/api/inventory', requireAgent, (req, res) => {
  const agent = db.getAgentById(req.session.agentId);
  res.json({ hotels: agent.hotels || [], packages: agent.packages || [] });
});

router.post('/api/inventory/hotels', requireAgent, (req, res) => {
  const { name, description, price, whatsappLink } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const agent  = db.getAgentById(req.session.agentId);
  const hotels = [...(agent.hotels || []), { id: uuidv4(), name, description: description || '', price: price || '', whatsappLink: whatsappLink || '' }];
  db.updateAgent(req.session.agentId, { hotels });
  res.json({ success: true, hotels });
});

router.delete('/api/inventory/hotels/:hid', requireAgent, (req, res) => {
  const agent = db.getAgentById(req.session.agentId);
  db.updateAgent(req.session.agentId, { hotels: (agent.hotels || []).filter(h => h.id !== req.params.hid) });
  res.json({ success: true });
});

router.post('/api/inventory/packages', requireAgent, (req, res) => {
  const { name, description, price, whatsappLink } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const agent    = db.getAgentById(req.session.agentId);
  const packages = [...(agent.packages || []), { id: uuidv4(), name, description: description || '', price: price || '', whatsappLink: whatsappLink || '' }];
  db.updateAgent(req.session.agentId, { packages });
  res.json({ success: true, packages });
});

router.delete('/api/inventory/packages/:pid', requireAgent, (req, res) => {
  const agent = db.getAgentById(req.session.agentId);
  db.updateAgent(req.session.agentId, { packages: (agent.packages || []).filter(p => p.id !== req.params.pid) });
  res.json({ success: true });
});

module.exports = router;
