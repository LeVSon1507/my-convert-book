export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  res.status(200).json({
    defaultProvider: process.env.DEFAULT_PROVIDER || 'openrouter',
    defaultModel: process.env.DEFAULT_MODEL || 'mistralai/mistral-nemo',
    keys: {
      openrouter: process.env.OPENROUTER_API_KEY || '',
      openai:
        process.env.OPENAI_API_KEY ||
        process.env.CHATGPT_API_KEY ||
        '',
      gemini:
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        '',
      grok:
        process.env.XAI_API_KEY ||
        process.env.GROK_API_KEY ||
        '',
      huggingface:
        process.env.HUGGINGFACE_API_KEY ||
        process.env.HF_API_KEY ||
        ''
    }
  });
}
