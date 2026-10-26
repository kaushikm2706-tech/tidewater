/**
 * Two AgLlmAdapter implementations for the Collector agent:
 *  - openAiCompatAdapter: talks to an OpenAI-compatible /chat/completions endpoint through the
 *    Tidewater server proxy (the API key never reaches the browser).
 *  - offlinePlanner: a deterministic, rule-based planner used when no LLM is configured. It is NOT a
 *    language model and says so in everything it writes.
 * Both emit AG-UI events (AgAiEvent) and resolve a consolidated AgLlmResponse, as the adapter contract requires.
 */
import type { AgLlmAdapter, AgLlmRequest, AgLlmResponseHandler } from 'ag-studio';

type Item = any;
let counter = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(counter++).toString(36)}`;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** Minimal async queue so an adapter can push events while a promise resolves the consolidated response. */
function channel<T>() {
  const q: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(v: T) { q.push(v); wake?.(); },
    close() { closed = true; wake?.(); },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (q.length) { yield q.shift()!; continue; }
          if (closed) return;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
    } as AsyncIterable<T>,
  };
}

// ---------------------------------------------------------------------------------- OpenAI-compatible
export function toOpenAiMessages(req: AgLlmRequest): any[] {
  const out: any[] = [];
  // Tool calls and results from earlier questions are bulky and already summarised in the assistant's
  // answer text, so only the current question's tool round trips are re-sent (keeps requests small
  // for providers with per-minute token limits).
  const items = req.input as Item[];
  let lastUser = -1;
  items.forEach((it, i) => { if (it.type === 'message' && it.kind === 'input' && it.role !== 'system') lastUser = i; });
  if (req.instructions) out.push({ role: 'system', content: req.instructions });
  let pending: any | null = null; // assistant message accumulating tool_calls
  const flush = () => { if (pending) { out.push(pending); pending = null; } };
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    if (idx < lastUser && (it.type === 'function_call' || it.type === 'function_call_output')) continue;
    if (it.type === 'message' && it.kind === 'input') {
      flush();
      out.push({ role: it.role === 'system' ? 'system' : 'user', content: it.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') });
    } else if (it.type === 'message' && it.kind === 'output') {
      flush();
      const text = it.content.map((c: any) => (c.type === 'text' ? c.text : c.refusal ?? '')).join('');
      if (text) out.push({ role: 'assistant', content: text });
    } else if (it.type === 'function_call') {
      pending ??= { role: 'assistant', content: null, tool_calls: [] };
      pending.tool_calls.push({ id: it.callId, type: 'function', function: { name: it.name, arguments: it.arguments || '{}' } });
    } else if (it.type === 'function_call_output') {
      flush();
      out.push({ role: 'tool', tool_call_id: it.callId, content: it.output });
    }
  }
  flush();
  return out;
}

export function openAiCompatAdapter(endpoint = '/api/llm/chat'): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options): AgLlmResponseHandler {
      const ch = channel<any>();
      const complete = (async () => {
        const id = uid('resp');
        const createdAt = Date.now();
        const textId = uid('msg');
        let text = '';
        let textStarted = false;
        const calls = new Map<number, { id: string; name: string; args: string }>();
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: options?.signal,
            body: JSON.stringify({
              messages: toOpenAiMessages(request),
              tools: request.tools?.length ? request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined,
              tool_choice: request.tools?.length ? (typeof request.toolChoice === 'object' ? { type: 'function', function: { name: request.toolChoice.name } } : request.toolChoice ?? 'auto') : undefined,
              temperature: 0.2,
              stream: true,
            }),
          });
          if (!res.ok) {
            const b = await res.json().catch(() => ({}));
            throw new Error(b?.error?.message ?? b?.error ?? `LLM request failed (${res.status})`);
          }
          const reader = res.body!.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              let chunk: any;
              try { chunk = JSON.parse(payload); } catch { continue; }
              const delta = chunk.choices?.[0]?.delta;
              if (!delta) continue;
              if (delta.content) {
                if (!textStarted) { textStarted = true; ch.push({ type: 'TEXT_MESSAGE_START', messageId: textId, role: 'assistant' }); }
                text += delta.content;
                ch.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: textId, delta: delta.content });
              }
              for (const tc of delta.tool_calls ?? []) {
                const idx = tc.index ?? 0;
                let c = calls.get(idx);
                if (!c) {
                  c = { id: tc.id ?? uid('call'), name: tc.function?.name ?? '', args: '' };
                  calls.set(idx, c);
                  ch.push({ type: 'TOOL_CALL_START', toolCallId: c.id, toolCallName: c.name });
                }
                if (tc.function?.name && !c.name) c.name = tc.function.name;
                if (tc.function?.arguments) {
                  c.args += tc.function.arguments;
                  ch.push({ type: 'TOOL_CALL_ARGS', toolCallId: c.id, delta: tc.function.arguments });
                }
              }
            }
          }
          if (textStarted) ch.push({ type: 'TEXT_MESSAGE_END', messageId: textId });
          for (const c of calls.values()) ch.push({ type: 'TOOL_CALL_END', toolCallId: c.id });
          const output: Item[] = [];
          if (text) output.push({ id: textId, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text, annotations: [] }] });
          for (const c of calls.values()) output.push({ id: c.id, kind: 'output', type: 'function_call', callId: c.id, name: c.name, arguments: c.args || '{}', status: 'completed' });
          return { id, createdAt, output, status: 'completed' as const };
        } catch (e: any) {
          if (e?.name === 'AbortError') return { id, createdAt, output: [], status: 'cancelled' as const };
          return { id, createdAt, output: [], status: 'failed' as const, error: { code: 'llm_error', message: String(e?.message ?? e) } };
        } finally {
          ch.close();
        }
      })();
      return { stream: ch.iterable, complete } as AgLlmResponseHandler;
    },
  };
}

// ---------------------------------------------------------------------------------- offline planner
interface PlannedCall { name: string; args: Record<string, unknown> }
type Plan = { text?: string; calls?: PlannedCall[] };

const OFFLINE_TAG = 'Offline planner (rule-based, not a language model)';

function lastUserText(input: Item[]): { text: string; index: number } {
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    if (it.type === 'message' && it.kind === 'input' && it.role === 'user') return { text: it.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' '), index: i };
  }
  return { text: '', index: -1 };
}

/** Studio wraps a tool's result as {success, response, data}; `response` is the string the tool returned. */
const parse = (s: string) => {
  try {
    const outer = JSON.parse(s);
    if (outer && typeof outer === 'object' && typeof outer.response === 'string') {
      try { return JSON.parse(outer.response); } catch { return { summary: outer.response }; }
    }
    return outer;
  } catch {
    return null;
  }
};

function plan(input: Item[]): Plan {
  const { text, index } = lastUserText(input);
  const after = input.slice(index + 1);
  const results = after.filter((i) => i.type === 'function_call_output');
  const callsMade = after.filter((i) => i.type === 'function_call') as Item[];
  const nameOf = (callId: string) => callsMade.find((c) => c.callId === callId)?.name;
  const t = text.toLowerCase();

  if (!callsMade.length) {
    const inv = /\b(inv-\d+|tw-[a-z0-9]+|sim-inv2-[a-z0-9]+|syn-[a-z]+-\d+)\b/i.exec(text);
    if (inv) return { calls: [{ name: 'get_forecast', args: { invoiceId: inv[0].toUpperCase() } }] };
    if (/(propose|remind|nudge|chase|collect|reminder|follow.?up|speed|accelerate|cash)/.test(t)) {
      const n = /\b(\d{1,2})\b/.exec(t);
      return { calls: [{ name: 'rank_nudges', args: { limit: Math.min(8, Math.max(1, n ? Number(n[1]) : 3)) } }] };
    }
    return { calls: [{ name: 'get_overview', args: {} }] };
  }

  const ranked = results.find((r) => nameOf(r.callId) === 'rank_nudges');
  const proposed = results.filter((r) => nameOf(r.callId) === 'propose_reminder');
  const overview = results.find((r) => nameOf(r.callId) === 'get_overview');
  const forecast = results.find((r) => nameOf(r.callId) === 'get_forecast');

  if (ranked && !proposed.length) {
    const data = parse(ranked.output);
    const items: any[] = data?.nudges ?? [];
    if (!items.length) return { text: `${OFFLINE_TAG}: no invoice currently passes the reminder policy with a positive expected gain. Nothing to propose.` };
    return { calls: items.slice(0, Math.min(items.length, 5)).map((n) => ({ name: 'propose_reminder', args: { invoiceId: n.invoiceId, reason: n.why } })) };
  }
  if (proposed.length) {
    const lines = proposed.map((p) => {
      const d = parse(p.output);
      if (!d) return '- (unreadable result)';
      if (d.error) return `- Blocked: ${d.error}`;
      return `- ${d.invoiceNumber} (${d.payerName}, ${d.amountText}): expected ${d.gainText} within 14 days. ${d.deduplicated ? 'A proposal was already pending.' : 'Draft is waiting for you.'}`;
    });
    return { text: `${OFFLINE_TAG}. I ranked open invoices by modelled 14-day cash gain and drafted reminders for the best ones. Nothing has been sent: review and confirm each in the Action Queue.\n\n${lines.join('\n')}` };
  }
  if (overview) {
    const d = parse(overview.output);
    if (!d) return { text: `${OFFLINE_TAG}: could not read the overview.` };
    return { text: `${OFFLINE_TAG}.\n\n${d.summary}\n\nAsk me to "propose reminders" and I will rank invoices by modelled cash gain and draft the best ones for your approval.` };
  }
  if (forecast) {
    const d = parse(forecast.output);
    return { text: `${OFFLINE_TAG}.\n\n${d?.summary ?? 'No forecast available for that invoice.'}` };
  }
  return { text: `${OFFLINE_TAG}: nothing more to do.` };
}

export function offlinePlanner(): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options): AgLlmResponseHandler {
      const ch = channel<any>();
      const complete = (async () => {
        const id = uid('resp');
        const createdAt = Date.now();
        const output: Item[] = [];
        try {
          const p = plan(request.input as Item[]);
          await sleep(220, options?.signal);
          if (p.text) {
            const mid = uid('msg');
            ch.push({ type: 'TEXT_MESSAGE_START', messageId: mid, role: 'assistant' });
            for (const w of p.text.split(/(\s+)/)) {
              if (options?.signal?.aborted) break;
              ch.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: mid, delta: w });
              if (w.trim()) await sleep(14, options?.signal);
            }
            ch.push({ type: 'TEXT_MESSAGE_END', messageId: mid });
            output.push({ id: mid, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: p.text, annotations: [] }] });
          }
          for (const c of p.calls ?? []) {
            const cid = uid('call');
            const args = JSON.stringify(c.args);
            ch.push({ type: 'TOOL_CALL_START', toolCallId: cid, toolCallName: c.name });
            ch.push({ type: 'TOOL_CALL_ARGS', toolCallId: cid, delta: args });
            ch.push({ type: 'TOOL_CALL_END', toolCallId: cid });
            output.push({ id: cid, kind: 'output', type: 'function_call', callId: cid, name: c.name, arguments: args, status: 'completed' });
          }
          return { id, createdAt, output, status: 'completed' as const };
        } finally {
          ch.close();
        }
      })();
      return { stream: ch.iterable, complete } as AgLlmResponseHandler;
    },
  };
}
