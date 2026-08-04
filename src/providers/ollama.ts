import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from './types.js';
import { ProviderError, classifyHttp, asProviderError, isRetryable } from './types.js';

// Native adapter (not openai-compat) for the GlasHaus tricks: /api/show
// context detection, keep_alive, and later local embeddings.

export class OllamaAdapter implements ProviderAdapter {
  readonly name = 'ollama';
  private numCtxCache = new Map<string, number>();
  private autoModel: string | null = null;

  constructor(private url: string) {}

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new ProviderError(`ollama /api/tags ${res.status}`, classifyHttp(res.status, ''));
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map(m => m.name);
  }

  /** "auto" → first model that isn't an embedder; cached for the process. */
  async resolveModel(model: string): Promise<string> {
    if (model !== 'auto') return model;
    if (this.autoModel) return this.autoModel;
    const models = await this.listModels();
    const pick = models.find(m => !/embed/i.test(m));
    if (!pick) {
      throw new ProviderError(
        'ollama has no chat-capable model installed (try: ollama pull <model>)',
        'bad_request',
      );
    }
    this.autoModel = pick;
    return pick;
  }

  // Models often DEFAULT to a small window and truncate from the top of the
  // prompt — which is where the system prompt lives. Detect once per model.
  private async numCtx(model: string): Promise<number> {
    const cached = this.numCtxCache.get(model);
    if (cached) return cached;
    let detected = 8192;
    try {
      const res = await fetch(`${this.url}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const info = ((await res.json()) as { model_info?: Record<string, unknown> }).model_info ?? {};
        const key = Object.keys(info).find(k => k.endsWith('.context_length'));
        if (key && Number(info[key]) > 0) detected = Number(info[key]);
      }
    } catch { /* offline or cloud model — the default holds */ }
    const ctx = Math.min(Math.max(detected, 2048), 32768);
    this.numCtxCache.set(model, ctx);
    return ctx;
  }

  async *chat(model: string, messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<StreamEvent> {
    const resolved = await this.resolveModel(model);
    const numCtx = await this.numCtx(resolved);

    // One transient retry before any bytes stream; after first byte, fail loud.
    let res: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${this.url}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: opts.signal,
          body: JSON.stringify({
            model: resolved,
            messages,
            stream: true,
            keep_alive: '30m',
            options: {
              num_ctx: numCtx,
              // Reply length can never be allowed to eat the window.
              num_predict: Math.min(opts.maxTokens ?? 4096, Math.floor(numCtx / 3)),
              ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
            },
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new ProviderError(`ollama ${res.status}: ${body.slice(0, 300)}`, classifyHttp(res.status, body), res.status);
        }
        break;
      } catch (err) {
        const perr = asProviderError(err, 'ollama');
        if (attempt === 0 && isRetryable(perr.reason)) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        throw perr;
      }
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawText = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        let j: any;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        if (j.error) throw new ProviderError(`ollama: ${j.error}`, 'server');
        const delta: string = j.message?.content ?? '';
        if (delta) {
          sawText = true;
          yield { type: 'text', text: delta };
        }
        if (j.done) {
          yield { type: 'usage', input: j.prompt_eval_count, output: j.eval_count };
        }
      }
    }
    if (!sawText) throw new ProviderError('ollama: model returned empty content', 'server');
    yield { type: 'done' };
  }
}
