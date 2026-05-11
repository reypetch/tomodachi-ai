require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPT = `You are Tomodachi, an AI local friend who knows Japan deeply. You speak like a friendly local — warm, knowledgeable, and honest. You don't just give tourist info, you share how Japan feels. Mix practical advice with emotional storytelling. Always include hidden gems, not just famous spots.

Your response must be a valid JSON object with this exact structure (no markdown, no code blocks, raw JSON only):
{
  "mood_title": "string - the travel mood name",
  "how_japan_feels": "string - 2-3 sentences, emotional and poetic, describing how Japan feels for this mood. Write in second person, like you're telling a friend.",
  "recommended_areas": ["area 1", "area 2", "area 3", "area 4"],
  "train_lines": ["Line name and tip 1", "Line name and tip 2", "Line name and tip 3"],
  "hidden_spots": [
    {"name": "Spot Name", "description": "2-3 sentence description with personal touch and why it matters"},
    {"name": "Spot Name", "description": "2-3 sentence description with personal touch and why it matters"},
    {"name": "Spot Name", "description": "2-3 sentence description with personal touch and why it matters"}
  ],
  "best_time": "string - when to visit and why, with seasonal details and practical timing",
  "food_recommendations": [
    {"name": "Food or place name", "description": "what it is and why it's special", "tip": "insider ordering or visiting tip"},
    {"name": "Food or place name", "description": "what it is and why it's special", "tip": "insider ordering or visiting tip"},
    {"name": "Food or place name", "description": "what it is and why it's special", "tip": "insider ordering or visiting tip"}
  ],
  "estimated_budget": {
    "amount": "¥X,XXX–¥X,XXX per day",
    "breakdown": "string - friendly breakdown of where the money actually goes day-to-day"
  },
  "local_tips": ["practical tip 1", "practical tip 2", "practical tip 3", "practical tip 4"],
  "cultural_notes": ["cultural insight 1", "cultural insight 2", "cultural insight 3"]
}`;

app.post('/api/itinerary', async (req, res) => {
  const { mood } = req.body;

  if (!mood) {
    return res.status(400).json({ error: 'Mood is required' });
  }

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Create a complete Japan travel itinerary for the mood: "${mood}". Speak to me like I'm your friend who's visiting Japan soon with this exact vibe. Make it personal, exciting, and full of details only a local would know. Return only the JSON object.`
        }
      ]
    });

    const responseText = message.content[0].text.trim();

    let jsonText = responseText;
    const codeBlockMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
      jsonText = codeBlockMatch[1];
    } else {
      const objMatch = responseText.match(/\{[\s\S]*\}/);
      if (objMatch) jsonText = objMatch[0];
    }

    const itinerary = JSON.parse(jsonText);
    res.json({ success: true, itinerary });

  } catch (error) {
    console.error('Error:', error.message);

    if (error.status === 401) {
      return res.status(401).json({ error: 'Invalid API key. Check your ANTHROPIC_API_KEY in .env' });
    }
    if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
    }
    if (error instanceof SyntaxError) {
      return res.status(500).json({ error: 'Failed to parse AI response. Please try again.' });
    }

    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🗾  Tomodachi.ai is live → http://localhost:${PORT}\n`);
});
