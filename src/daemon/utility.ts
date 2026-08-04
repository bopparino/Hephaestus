import type { Providers } from '../providers/roles.js';
import type { ChatMessage } from '../providers/types.js';

// The utility lane: bookkeeping passes (capture, folding, consolidation)
// that want determinism and tolerate small local models.

export async function utilityText(providers: Providers, messages: ChatMessage[], maxTokens = 2000): Promise<string> {
  const { adapter, model: bound } = providers.resolve('utility');
  const model = adapter.resolveModel ? await adapter.resolveModel(bound) : bound;
  let text = '';
  for await (const ev of adapter.chat(model, messages, { maxTokens, temperature: 0, think: false })) {
    if (ev.type === 'text') text += ev.text;
  }
  return text;
}

/** Ask for JSON, tolerate sloppy output — small local models still wrap JSON
 *  in fences in 2026, and truncation happens. Ported from GlasHaus. */
export async function utilityJson<T = Record<string, unknown>>(
  providers: Providers,
  messages: ChatMessage[],
  maxTokens = 2500,
): Promise<T | null> {
  const raw = await utilityText(providers, messages, maxTokens);
  const text = raw
    .replace(/^[\s\S]*?```(?:json)?\s*/i, m => (raw.includes('```') ? '' : m))
    .replace(/```[\s\S]*$/, '')
    .trim() || raw;
  const candidates = [text, raw, (raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/) ?? [])[0]];
  // Truncated {"facts":[...]}-style output: cut to the last complete object
  // and close the containers.
  const lastObj = text.lastIndexOf('},');
  if (lastObj > 0) candidates.push(text.slice(0, lastObj + 1) + ']}');
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c) as T;
    } catch { /* try next shape */ }
  }
  console.error('[utilityJson] unparseable output:', raw.slice(0, 300));
  return null;
}
