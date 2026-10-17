// A tiny OpenAI-compatible /chat/completions mock (streaming SSE + tool calls) used to test the LLM path without a key.
// Not a language model: it follows a fixed script. Usage: node tools/mock-llm.mjs [port]
import http from 'node:http';

const port = Number(process.argv[2] ?? 8799);
const sse = (res, chunks) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const delta = (d, finish = null) => ({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] });

http
  .createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const auth = req.headers.authorization;
    if (auth !== 'Bearer mock-key') { res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } })); return; }
    const msgs = body.messages;
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    const toolNames = new Set((body.tools ?? []).map((t) => t.function.name));
    if (!toolMsgs.length && toolNames.has('rank_nudges')) {
      // split the arguments across chunks to exercise incremental parsing
      return sse(res, [
        delta({ role: 'assistant', content: 'Let me look at the best candidates. ' }),
        delta({ tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'rank_nudges', arguments: '{"li' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'mit":2}' } }] }),
        delta({}, 'tool_calls'),
      ]);
    }
    const last = toolMsgs.at(-1)?.content ?? '';
    let n = 0;
    try { n = JSON.parse(JSON.parse(last).response).nudges.length; } catch { /* fine */ }
    return sse(res, [delta({ role: 'assistant', content: `Mock LLM here: the ranking tool returned ${n} candidate${n === 1 ? '' : 's'}. ` }), delta({ content: 'No reminder has been sent; review drafts in the Action Queue.' }), delta({}, 'stop')]);
  })
  .listen(port, () => console.log(`mock LLM on :${port}`));
