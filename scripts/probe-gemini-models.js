require('dotenv').config();
const https = require('https');

const apiKey = (process.env.GEMINI_API_KEY || '').trim();
const models = [
  'gemini-flash-latest',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.0-flash',
  'gemini-2.5-flash'
];

const body = JSON.stringify({
  contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }],
  generationConfig: { maxOutputTokens: 8 }
});

function test(model) {
  return new Promise((resolve) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 10000
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let detail = '';
          try {
            const parsed = JSON.parse(data);
            detail = parsed?.candidates?.[0]?.content?.parts?.[0]?.text
              || parsed?.error?.message
              || data.slice(0, 120);
          } catch {
            detail = data.slice(0, 120);
          }
          console.log(`${model} ${res.statusCode} ${String(detail).replace(/\s+/g, ' ').slice(0, 140)}`);
          resolve();
        });
      }
    );
    req.on('error', (error) => {
      console.log(`${model} ERR ${error.message}`);
      resolve();
    });
    req.on('timeout', () => {
      console.log(`${model} TIMEOUT`);
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const model of models) {
    await test(model);
  }
})();
