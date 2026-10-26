/**
 * Checks the configured LLM endpoint end to end, without the UI: key accepted, model name valid,
 * plain chat works, and tool calling works (the Collector agent depends on tools).
 * Usage: npm run llm:check   (reads LLM_BASE_URL, LLM_API_KEY, LLM_MODEL from .env). The key is never printed.
 */
import { loadConfig } from '../config';

const cfg = loadConfig();
const { baseUrl, apiKey, model } = cfg.llm;

if (!baseUrl || !apiKey || !model) {
  console.error('Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in .env first (see .env.example). Missing:', [!baseUrl && 'LLM_BASE_URL', !apiKey && 'LLM_API_KEY', !model && 'LLM_MODEL'].filter(Boolean).join(', '));
  process.exit(1);
}
console.log(`Endpoint: ${baseUrl}\nModel:    ${model}\n`);

async function chat(body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, ...body }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

function fail(step: string, r: { status: number; text: string }) {
  console.error(`FAIL  ${step}: HTTP ${r.status}\n${r.text.slice(0, 600)}`);
  process.exit(2);
}

// 1. plain chat
const a = await chat({ messages: [{ role: 'user', content: 'Reply with the single word: ready' }], temperature: 0 });
if (a.status !== 200) fail('plain chat', a);
console.log('PASS  plain chat ->', JSON.stringify(a.json?.choices?.[0]?.message?.content ?? '').slice(0, 80));

// 2. tool calling
const tools = [
  {
    type: 'function',
    function: {
      name: 'invoice_total',
      description: 'Returns the total outstanding amount in USD for a payer name.',
      parameters: { type: 'object', properties: { payer: { type: 'string' } }, required: ['payer'] },
    },
  },
];
const b = await chat({
  messages: [{ role: 'user', content: 'How much does Kestrel Labs owe? Use the tool.' }],
  tools,
  tool_choice: 'auto',
  temperature: 0,
});
if (b.status !== 200) fail('tool calling', b);
const calls = b.json?.choices?.[0]?.message?.tool_calls;
if (!Array.isArray(calls) || !calls.length) {
  console.error('FAIL  tool calling: the model answered without calling the tool. This model may not support tools:', JSON.stringify(b.json?.choices?.[0]?.message ?? b.text).slice(0, 400));
  process.exit(3);
}
console.log('PASS  tool calling ->', calls[0].function?.name, calls[0].function?.arguments);

// 3. tool result round trip (the agent loop sends the result back)
const c = await chat({
  messages: [
    { role: 'user', content: 'How much does Kestrel Labs owe? Use the tool.' },
    b.json.choices[0].message,
    { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify({ payer: 'Kestrel Labs', total: 18375 }) },
  ],
  tools,
  temperature: 0,
});
if (c.status !== 200) fail('tool result round trip', c);
console.log('PASS  tool round trip ->', JSON.stringify(c.json?.choices?.[0]?.message?.content ?? '').slice(0, 160));
console.log('\nAll checks passed. Start the app with: npm start (header badge should show the model name).');
