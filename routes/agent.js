const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../lib/db');
const { requireAgent } = require('../lib/auth');

// TODO: migrate logo storage to Railway Volume or Cloudinary for persistence
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
  try {
    const { email, password } = req.body;
    const agent = await db.getAgentByEmail(email);
    if (!agent) return res.status(401).json({ error: 'Invalid credentials' });
    if (agent.status !== 'active') return res.status(403).json({ error: 'Account inactive — contact support' });
    if (!await bcrypt.compare(password, agent.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    req.session.agentId = agent.id;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {});
  res.redirect('/agent/login');
});

router.get('/dashboard', requireAgent, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'agent-dashboard.html'));
});

// ── Profile ────────────────────────────────────────────────────
router.get('/api/me', requireAgent, async (req, res) => {
  try {
    const agent = await db.getAgentById(req.session.agentId);
    if (!agent) return res.status(404).json({ error: 'Not found' });
    res.json({ ...agent, password: undefined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/me', requireAgent, async (req, res) => {
  try {
    const { whatsapp, name } = req.body;
    const updates = {};
    if (whatsapp !== undefined) updates.whatsapp = whatsapp;
    if (name     !== undefined) updates.name     = name;
    await db.updateAgent(req.session.agentId, updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/logo', requireAgent, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const logo = `/logos/${req.file.filename}`;
    await db.updateAgent(req.session.agentId, { logo });
    res.json({ success: true, logo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stats ──────────────────────────────────────────────────────
router.get('/api/stats', requireAgent, async (req, res) => {
  try {
    const clients   = await db.getClientsByAgentId(req.session.agentId);
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Clients ────────────────────────────────────────────────────
router.get('/api/clients', requireAgent, async (req, res) => {
  try {
    const clients = await db.getClientsByAgentId(req.session.agentId);
    res.json(clients.map(c => ({ ...c, password: undefined })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/clients', requireAgent, async (req, res) => {
  try {
    const { name, email, days = 30 } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

    const existing = await db.getClientByEmail(email, req.session.agentId);
    if (existing) return res.status(400).json({ error: 'Email already registered for this agent' });

    const tempPassword = Math.random().toString(36).slice(-8);
    const expiry = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000);

    const client = {
      id:                 uuidv4(),
      agentId:            req.session.agentId,
      name, email,
      password:           await bcrypt.hash(tempPassword, 10),
      status:             'active',
      subscriptionExpiry: expiry.toISOString().split('T')[0],
      stripeCustomerId:   null
    };

    await db.addClient(client);
    res.json({ success: true, client: { ...client, password: undefined }, tempPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/clients/:id/status', requireAgent, async (req, res) => {
  try {
    const clients = await db.getClientsByAgentId(req.session.agentId);
    const client  = clients.find(c => c.id === req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const newStatus = client.status === 'active' ? 'inactive' : 'active';
    await db.updateClient(client.id, { status: newStatus });
    res.json({ success: true, status: newStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Inventory ──────────────────────────────────────────────────
router.get('/api/inventory', requireAgent, async (req, res) => {
  try {
    const agent = await db.getAgentById(req.session.agentId);
    res.json({ hotels: agent.hotels || [], packages: agent.packages || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/inventory/hotels', requireAgent, async (req, res) => {
  try {
    const { name, description, price, whatsappLink } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const agent  = await db.getAgentById(req.session.agentId);
    const hotels = [...(agent.hotels || []), {
      id: uuidv4(), name,
      description:  description  || '',
      price:        price        || '',
      whatsappLink: whatsappLink || ''
    }];
    await db.updateAgent(req.session.agentId, { hotels });
    res.json({ success: true, hotels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/inventory/hotels/:hid', requireAgent, async (req, res) => {
  try {
    const agent  = await db.getAgentById(req.session.agentId);
    const hotels = (agent.hotels || []).filter(h => h.id !== req.params.hid);
    await db.updateAgent(req.session.agentId, { hotels });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/inventory/packages', requireAgent, async (req, res) => {
  try {
    const { name, description, price, whatsappLink } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const agent    = await db.getAgentById(req.session.agentId);
    const packages = [...(agent.packages || []), {
      id: uuidv4(), name,
      description:  description  || '',
      price:        price        || '',
      whatsappLink: whatsappLink || ''
    }];
    await db.updateAgent(req.session.agentId, { packages });
    res.json({ success: true, packages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api/inventory/packages/:pid', requireAgent, async (req, res) => {
  try {
    const agent    = await db.getAgentById(req.session.agentId);
    const packages = (agent.packages || []).filter(p => p.id !== req.params.pid);
    await db.updateAgent(req.session.agentId, { packages });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
