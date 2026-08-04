import type { ChatMessage, ChatOptions, ProviderAdapter, StreamEvent } from './types.js';
import { ProviderError, classifyHttp, asProviderError } from './types.js';

const API = 'https://api.anthropic.com/v1/messages';

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic';

  constructor(private getKey: () => string | undefined) {}

  async *chat(model: string, messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<StreamEvent> {
    const key = this.getKey();
    if (!key) {
      throw new ProviderError(
        'no Anthropic API key — set ANTHROPIC_API_KEY or add it to ~/.hephaestus/secrets',
        'auth',
      );
    }

    // Anthropic takes system as a top-level field, not a message.
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const turns = messages.filter(m => m.role !== 'system');

    let res: Response;
    try {
      res = await fetch(API, {
        method: 'POST',
        signal: opts.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 4096,
          ...(system ? { system } : {}),
          ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
          messages: turns,
          stream: true,
        }),
      });
    } catch (err) {
      throw asProviderError(err, 'anthropic');
    }
    if (!res.ok) {
      const body = await res.text();
      throw new ProviderError(
        `anthropic ${res.status}: ${body.slice(0, 300)}`,
        classifyHttp(res.status, body),
        res.status,
      );
    }

    // SSE: "event: <type>\ndata: <json>\n\n"
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let j: any;
        try {
          j = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        switch (j.type) {
          case 'content_block_delta':
            if (j.delta?.type === 'text_delta' && j.delta.text) {
              yield { type: 'text', text: j.delta.text };
            }
            break;
          case 'message_start':
            if (j.message?.usage?.input_tokens != null) {
              yield { type: 'usage', input: j.message.usage.input_tokens };
            }
            break;
          case 'message_delta':
            if (j.usage?.output_tokens != null) {
              yield { type: 'usage', output: j.usage.output_tokens };
            }
            break;
          case 'error':
            throw new ProviderError(
              `anthropic: ${j.error?.message ?? 'stream error'}`,
              j.error?.type === 'overloaded_error' ? 'overloaded' : 'server',
            );
        }
      }
    }
    yield { type: 'done' };
  }
}
