// Vercel serverless function: POST /api/chat
// Set ANTHROPIC_API_KEY in Vercel → Project → Settings → Environment Variables.
import { chat, rateLimited } from './_chat-core.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'bad' });
    return;
  }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if (rateLimited(ip)) {
    res.status(429).json({ error: 'rate' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const r = await chat(body || {});
  res.status(r.status).json(r.json);
}
