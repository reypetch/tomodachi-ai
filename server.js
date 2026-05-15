require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);
const path       = require('path');
const Anthropic  = require('@anthropic-ai/sdk');
const { initDB } = require('./lib/db');

process.on('uncaughtException',  err => console.error('Uncaught exception:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

const app    = express();
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Stripe webhook needs raw body — must be registered before express.json() ──
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    next();
  }
});

// ── Core middleware ────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new pgSession({
    conString:            process.env.DATABASE_URL,
    tableName:            'sessions',
    createTableIfMissing: true
  }),
  secret:            process.env.SESSION_SECRET || 'dev-secret',
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── Consumer API (original, unchanged) ────────────────────────
const SYSTEM_PROMPT = `You are Tomodachi, an AI local friend who knows Japan deeply. You speak like a friendly local — warm, knowledgeable, and honest. You don't just give tourist info, you share how Japan feels. Mix practical advice with emotional storytelling. Always include hidden gems, not just famous spots.

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

const CHAT_SYSTEM_PROMPT = `You are Tomodachi, a warm and knowledgeable local friend who knows Japan inside out. You help travelers with any Japan question — trains, food, culture, hidden gems, budget tips, safety, etiquette, and day-to-day life.

Your style: friendly and direct, like texting a well-traveled local friend. Mix practical info with personal opinions. Say things like "I always do X" or "honestly, skip Y." Use emojis occasionally but sparingly. Keep replies conversational and under ~250 words unless the question genuinely needs more depth.

Your expertise: Suica/IC cards, JR Pass, train navigation, Tokyo neighborhoods, ramen and izakayas, solo travel safety, cultural dos and don'ts, seasonal events, budget hacks, language basics, and getting off the tourist trail.

Important: Never introduce yourself as an AI. You're just a local friend who happens to know a lot.`;

app.post('/api/itinerary', async (req, res) => {
  const { mood } = req.body;
  if (!mood) return res.status(400).json({ error: 'Mood is required' });

  try {
    const message = await claude.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: `Create a complete Japan travel itinerary for the mood: "${mood}". Speak to me like I'm your friend who's visiting Japan soon with this exact vibe. Make it personal, exciting, and full of details only a local would know. Return only the JSON object.` }]
    });

    let text = message.content[0].text.trim();
    const cb = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (cb) text = cb[1];
    else { const m = text.match(/\{[\s\S]*\}/); if (m) text = m[0]; }

    const defaults = {
      mood_title: mood, how_japan_feels: 'Japan has a way of making you feel both completely lost and perfectly at home.',
      recommended_areas: [], train_lines: [], hidden_spots: [],
      best_time: 'Spring (March–May) and autumn (September–November) are ideal for most travel styles.',
      food_recommendations: [], estimated_budget: { amount: '¥5,000–¥10,000 per day', breakdown: 'Budget varies by dining choices and activities.' },
      local_tips: [], cultural_notes: [],
    };
    const itinerary = { ...defaults, ...JSON.parse(text) };
    res.json({ success: true, itinerary });

  } catch (error) {
    console.error('Itinerary error:', error.message);
    if (error.status === 401) return res.status(401).json({ error: 'Invalid API key. Check your ANTHROPIC_API_KEY in .env' });
    if (error.status === 429) return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
    if (error instanceof SyntaxError) return res.status(500).json({ error: 'Failed to parse AI response. Please try again.' });
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: 'Messages array is required' });

  const safe = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

  if (!safe.length || safe[safe.length - 1].role !== 'user')
    return res.status(400).json({ error: 'Last message must be from user' });

  try {
    const message = await claude.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      system: CHAT_SYSTEM_PROMPT, messages: safe,
    });
    res.json({ reply: message.content[0].text });
  } catch (error) {
    console.error('Chat error:', error.message);
    if (error.status === 401) return res.status(401).json({ error: 'Invalid API key.' });
    if (error.status === 429) return res.status(429).json({ error: 'Rate limit reached. Try again in a moment.' });
    res.status(500).json({ error: 'Failed to get response. Please try again.' });
  }
});

// ── Public config ──────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ mapboxToken: process.env.MAPBOX_TOKEN || '' });
});

app.get('/api/agents/public', async (req, res) => {
  try {
    const { getAgents } = require('./lib/db');
    const agents = await getAgents();
    res.json(
      agents
        .filter(a => a.status === 'active')
        .map(a => ({
          slug:         a.slug,
          name:         a.name,
          logo:         a.logo,
          whatsapp:     a.whatsapp,
          packageCount: (a.packages || []).length,
          hotelCount:   (a.hotels   || []).length
        }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── B2B routes ─────────────────────────────────────────────────
app.use('/admin', require('./routes/admin'));
app.use('/agent', require('./routes/agent'));
app.use('/',      require('./routes/client'));   // handles /:agentSlug/* and /

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
(async () => {
  try {
    await initDB();
  } catch (err) {
    console.error('DB init failed — check DATABASE_URL:', err.message);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🗾 Tomodachi.ai is live → http://localhost:${PORT}`);
    console.log(`   Consumer:  http://localhost:${PORT}/`);
    console.log(`   Admin:     http://localhost:${PORT}/admin`);
    console.log(`   Agent:     http://localhost:${PORT}/agent/login`);
  });
})();
