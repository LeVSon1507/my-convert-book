export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body =
      typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const provider = String(body.provider || '').trim();
    const baseUrl = String(body.baseUrl || '').trim().replace(/\/$/, '');
    const payload = body.payload;
    const apiKey = String(body.apiKey || '').trim();

    if (!provider || !baseUrl || !payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Invalid proxy payload' });
      return;
    }

    if (provider !== 'ollama' && !apiKey) {
      res.status(400).json({ error: 'Missing apiKey' });
      return;
    }

    const targetUrl =
      provider === 'ollama' ? `${baseUrl}/api/chat` : `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (provider !== 'ollama') {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    let parsed;
    try {
      parsed = JSON.parse(text || '{}');
    } catch {
      parsed = { raw: text };
    }

    res.status(upstream.status).json(parsed);
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Proxy request failed' });
  }
}
