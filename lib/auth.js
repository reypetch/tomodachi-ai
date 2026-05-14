const db = require('./db');

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json'))
    return res.status(401).json({ error: 'Admin authentication required' });
  res.redirect('/admin/login');
}

function requireAgent(req, res, next) {
  if (req.session && req.session.agentId) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json'))
    return res.status(401).json({ error: 'Agent authentication required' });
  res.redirect('/agent/login');
}

async function requireActiveClient(req, res, next) {
  const slug = req.params.agentSlug;
  if (!req.session || !req.session.clientId) return res.redirect(`/${slug}/login`);

  try {
    const client = await db.getClientById(req.session.clientId);
    if (!client) { req.session.destroy(() => {}); return res.redirect(`/${slug}/login`); }

    if (client.status === 'pending') return res.redirect(`/${slug}?pending=1`);
    if (client.status !== 'active') { req.session.destroy(() => {}); return res.redirect(`/${slug}/login`); }

    if (client.subscriptionExpiry && new Date(client.subscriptionExpiry) < new Date()) {
      await db.updateClient(client.id, { status: 'expired' });
      req.session.destroy(() => {});
      return res.redirect(`/${slug}/login?expired=1`);
    }

    req.client = client;
    next();
  } catch (err) {
    console.error('requireActiveClient error:', err.message);
    res.redirect(`/${slug}/login`);
  }
}

module.exports = { requireAdmin, requireAgent, requireActiveClient };
