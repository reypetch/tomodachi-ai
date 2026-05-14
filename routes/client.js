const express   = require('express');
const router    = express.Router();
const bcrypt    = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../lib/db');
const { requireActiveClient } = require('../lib/auth');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildItinerarySystem(agent) {
  let inv = '';
  if (agent && agent.hotels && agent.hotels.length) {
    inv += '\n\nRecommended hotels from this travel agent (mention naturally when relevant):\n' +
      agent.hotels.map(h => `- ${h.name}${h.price ? ` (${h.price})` : ''}: ${h.description}`).join('\n');
  }
  if (agent && agent.packages && agent.packages.length) {
    inv += '\n\nTour packages from this travel agent (mention naturally when relevant):\n' +
      agent.packages.map(p => `- ${p.name}${p.price ? ` (${p.price})` : ''}: ${p.description}`).join('\n');
  }
  return `You are Tomodachi, an AI local friend who knows Japan deeply. You speak like a friendly local — warm, knowledgeable, and honest. You don't just give tourist info, you share how Japan feels. Mix practical advice with emotional storytelling. Always include hidden gems, not just famous spots.${inv}

CRITICAL: Your entire response must be a single raw JSON object. No markdown, no backticks, no explanation — only the JSON.

Required structure:
{
  "mood_title": "the travel mood name as a string",
  "how_japan_feels": "2-3 emotional, poetic sentences in second person describing how Japan feels for this mood",
  "recommended_areas": ["Area Name 1", "Area Name 2", "Area Name 3", "Area Name 4"],
  "train_lines": ["Line Name — one sentence tip", "Line Name — one sentence tip", "Line Name — one sentence tip"],
  "hidden_spots": [
    {"name": "Spot Name", "description": "2-3 sentences: what it is, why it's special, personal angle"},
    {"name": "Spot Name", "description": "2-3 sentences: what it is, why it's special, personal angle"},
    {"name": "Spot Name", "description": "2-3 sentences: what it is, why it's special, personal angle"}
  ],
  "best_time": "A paragraph on when to visit, seasonal details, timing tips",
  "food_recommendations": [
    {"name": "Dish or Place Name", "description": "what it is and why it matters", "tip": "insider ordering or visiting tip"},
    {"name": "Dish or Place Name", "description": "what it is and why it matters", "tip": "insider ordering or visiting tip"},
    {"name": "Dish or Place Name", "description": "what it is and why it matters", "tip": "insider ordering or visiting tip"}
  ],
  "estimated_budget": {
    "amount": "¥X,XXX–¥X,XXX per day",
    "breakdown": "Friendly 2-3 sentence breakdown of where the money goes"
  },
  "local_tips": ["Practical tip 1", "Practical tip 2", "Practical tip 3", "Practical tip 4"],
  "cultural_notes": ["Cultural insight 1", "Cultural insight 2", "Cultural insight 3"]
}`;
}

function buildChatSystem(agent) {
  let extra = '';
  if (agent && agent.hotels   && agent.hotels.length)
    extra += '\nHotel options available through your travel agent: ' + agent.hotels.map(h => h.name).join(', ');
  if (agent && agent.packages && agent.packages.length)
    extra += '\nTour packages available: ' + agent.packages.map(p => p.name).join(', ');
  if (agent && agent.whatsapp)
    extra += `\nFor bookings, direct the traveler to contact their travel agent on WhatsApp: ${agent.whatsapp}`;
  return `You are Tomodachi, a warm and knowledgeable local friend who knows Japan inside out. You help travelers with any Japan question — trains, food, culture, hidden gems, budget tips, safety, etiquette, and day-to-day life.

Your style: friendly and direct, like texting a well-traveled local friend. Mix practical info with personal opinions. Say things like "I always do X" or "honestly, skip Y." Use emojis occasionally but sparingly. Keep replies conversational and under ~250 words unless the question genuinely needs more depth.

Important: Never introduce yourself as an AI. You're just a local friend who happens to know a lot.${extra}`;
}

// ── Static pages ───────────────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Public brand data
router.get('/api/brand/:slug', async (req, res) => {
  try {
    const agent = await db.getAgentBySlug(req.params.slug);
    if (!agent || agent.status !== 'active') return res.status(404).json({ error: 'Not found' });
    res.json({ name: agent.name, logo: agent.logo, whatsapp: agent.whatsapp, slug: agent.slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// /:agentSlug — client landing / register
router.get('/:agentSlug', async (req, res, next) => {
  if (['favicon.ico', 'robots.txt'].includes(req.params.agentSlug)) return next();
  try {
    const agent = await db.getAgentBySlug(req.params.agentSlug);
    if (!agent || agent.status !== 'active') return next();
    res.sendFile(path.join(__dirname, '..', 'views', 'client-register.html'));
  } catch { next(); }
});

// /:agentSlug/login
router.get('/:agentSlug/login', async (req, res, next) => {
  try {
    const agent = await db.getAgentBySlug(req.params.agentSlug);
    if (!agent || agent.status !== 'active') return next();
    res.sendFile(path.join(__dirname, '..', 'views', 'client-login.html'));
  } catch { next(); }
});

// /:agentSlug/app — protected white-label app
router.get('/:agentSlug/app', requireActiveClient, async (req, res, next) => {
  try {
    const agent = await db.getAgentBySlug(req.params.agentSlug);
    if (!agent || agent.status !== 'active') return next();
    res.sendFile(path.join(__dirname, '..', 'views', 'client-app.html'));
  } catch { next(); }
});

// /:agentSlug/success — Stripe payment return
router.get('/:agentSlug/success', async (req, res, next) => {
  try {
    const agent = await db.getAgentBySlug(req.params.agentSlug);
    if (!agent) return next();
    if (!stripe) return res.redirect(`/${agent.slug}/app`);

    const stripeSession = await stripe.checkout.sessions.retrieve(req.query.session_id);
    if (stripeSession.payment_status === 'paid') {
      const expiry = new Date(Date.now() + 30*24*60*60*1000);
      await db.updateClient(stripeSession.metadata.clientId, {
        status:             'active',
        subscriptionExpiry: expiry.toISOString().split('T')[0],
        stripeCustomerId:   stripeSession.customer || null
      });
      req.session.clientId  = stripeSession.metadata.clientId;
      req.session.agentSlug = agent.slug;
      return res.redirect(`/${agent.slug}/app`);
    }
    res.redirect(`/${agent.slug}?payment_failed=1`);
  } catch (err) {
    console.error('Stripe success error:', err.message);
    res.status(500).send('Payment verification failed. Please contact support.');
  }
});

// ── Stripe webhook (raw body registered in server.js) ─────────
router.post('/api/stripe/webhook', async (req, res) => {
  if (!stripe) return res.json({ received: true });
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    if (s.metadata && s.metadata.clientId) {
      const expiry = new Date(Date.now() + 30*24*60*60*1000);
      await db.updateClient(s.metadata.clientId, {
        status:             'active',
        subscriptionExpiry: expiry.toISOString().split('T')[0],
        stripeCustomerId:   s.customer || null
      });
    }
  }
  res.json({ received: true });
});

// ── Client register API ────────────────────────────────────────
router.post('/api/client/:agentSlug/register', async (req, res) => {
  try {
    const agent = await db.getAgentBySlug(req.params.agentSlug);
    if (!agent || agent.status !== 'active')
      return res.status(404).json({ error: 'Agent not found' });

    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'All fields required' });

    const existing = await db.getClientByEmail(email, agent.id);
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    if (stripe) {
      const pending = {
        id: uuidv4(), agentId: agent.id, name, email,
        password:           await bcrypt.hash(password, 10),
        status:             'pending',
        subscriptionExpiry: null,
        stripeCustomerId:   null
      };
      await db.addClient(pending);

      const checkout = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode:                 'payment',
        line_items: [{ price_data: {
          currency:     'usd',
          product_data: { name: `${agent.name} — 30 Day Access` },
          unit_amount:  500
        }, quantity: 1 }],
        customer_email: email,
        metadata:       { clientId: pending.id, agentSlug: agent.slug },
        success_url: `${process.env.BASE_URL || 'http://localhost:3000'}/${agent.slug}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${process.env.BASE_URL || 'http://localhost:3000'}/${agent.slug}?canceled=1`
      });
      return res.json({ success: true, checkoutUrl: checkout.url });
    }

    // No Stripe — activate immediately (dev / manual billing)
    const expiry = new Date(Date.now() + 30*24*60*60*1000);
    const client = {
      id: uuidv4(), agentId: agent.id, name, email,
      password:           await bcrypt.hash(password, 10),
      status:             'active',
      subscriptionExpiry: expiry.toISOString().split('T')[0],
      stripeCustomerId:   null
    };
    await db.addClient(client);
    req.session.clientId  = client.id;
    req.session.agentSlug = agent.slug;
    res.json({ success: true, redirect: `/${agent.slug}/app` });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Client login API ───────────────────────────────────────────
router.post('/api/client/:agentSlug/login', async (req, res) => {
  try {
    const agent = await db.getAgentBySlug(req.params.agentSlug);
    if (!agent || agent.status !== 'active')
      return res.status(404).json({ error: 'Agent not found' });

    const { email, password } = req.body;
    const client = await db.getClientByEmail(email, agent.id);
    if (!client || !await bcrypt.compare(password, client.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    if (client.status === 'pending')
      return res.status(403).json({ error: 'Payment not completed. Please register and pay first.' });
    if (client.status === 'inactive')
      return res.status(403).json({ error: 'Account deactivated. Contact your travel agent.' });
    if (client.subscriptionExpiry && new Date(client.subscriptionExpiry) < new Date())
      return res.status(403).json({ error: 'Subscription expired. Contact your travel agent to renew.', expired: true });

    req.session.clientId  = client.id;
    req.session.agentSlug = agent.slug;
    res.json({ success: true, redirect: `/${agent.slug}/app` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Client logout ──────────────────────────────────────────────
router.get('/api/client/logout', (req, res) => {
  const slug = req.session.agentSlug;
  req.session.destroy(() => {});
  res.redirect(slug ? `/${slug}/login` : '/');
});

// ── Client itinerary (authenticated) ──────────────────────────
router.post('/api/client/itinerary', async (req, res) => {
  if (!req.session || !req.session.clientId)
    return res.status(401).json({ error: 'Not authenticated' });

  try {
    const client = await db.getClientById(req.session.clientId);
    if (!client) return res.status(401).json({ error: 'Session invalid' });

    const { mood } = req.body;
    if (!mood) return res.status(400).json({ error: 'Mood is required' });

    const agent = await db.getAgentById(client.agentId);

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     buildItinerarySystem(agent),
      messages:   [{ role: 'user', content: `Create a complete Japan travel itinerary for the mood: "${mood}". Speak to me like I'm your friend who's visiting Japan soon with this exact vibe. Make it personal, exciting, and full of details only a local would know. Return only the JSON object.` }]
    });

    let text = message.content[0].text.trim();
    const cb = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (cb) text = cb[1];
    else { const m = text.match(/\{[\s\S]*\}/); if (m) text = m[0]; }

    const defaults = {
      mood_title: mood, how_japan_feels: '', recommended_areas: [],
      train_lines: [], hidden_spots: [], best_time: '',
      food_recommendations: [], estimated_budget: { amount: '', breakdown: '' },
      local_tips: [], cultural_notes: []
    };
    const itinerary = { ...defaults, ...JSON.parse(text) };
    itinerary.agentWhatsapp = (agent && agent.whatsapp) || null;
    itinerary.agentName     = (agent && agent.name)     || null;
    res.json({ success: true, itinerary });
  } catch (err) {
    if (err instanceof SyntaxError) return res.status(500).json({ error: 'Failed to parse AI response. Please try again.' });
    if (err.status === 401) return res.status(401).json({ error: 'Invalid API key.' });
    if (err.status === 429) return res.status(429).json({ error: 'Rate limit reached. Please wait a moment.' });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Client chat (authenticated) ────────────────────────────────
router.post('/api/client/chat', async (req, res) => {
  if (!req.session || !req.session.clientId)
    return res.status(401).json({ error: 'Not authenticated' });

  try {
    const client = await db.getClientById(req.session.clientId);
    if (!client) return res.status(401).json({ error: 'Session invalid' });

    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length)
      return res.status(400).json({ error: 'Messages array is required' });

    const agent = await db.getAgentById(client.agentId);
    const safe  = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-10)
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

    if (!safe.length || safe[safe.length - 1].role !== 'user')
      return res.status(400).json({ error: 'Last message must be from user' });

    const message = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     buildChatSystem(agent),
      messages:   safe
    });
    res.json({ reply: message.content[0].text });
  } catch (err) {
    if (err.status === 401) return res.status(401).json({ error: 'Invalid API key.' });
    if (err.status === 429) return res.status(429).json({ error: 'Rate limit reached. Try again in a moment.' });
    res.status(500).json({ error: 'Failed to get response. Please try again.' });
  }
});

module.exports = router;
