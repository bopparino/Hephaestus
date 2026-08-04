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

    // Anthropic takes system as a top-level field, not a message; tool
    // results ride as tool_result blocks in user turns, and consecutive
    // tool messages must merge into ONE user turn (roles alternate).
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const turns: { role: 'user' | 'assistant'; content: unknown }[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
        const last = turns.at(-1);
        if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
        else turns.push({ role: 'user', content: [block] });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        turns.push({
          role: 'assistant',
          content: [
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ...m.toolCalls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
          ],
        });
      } else if (m.role === 'user' && m.images?.length) {
        turns.push({
          role: 'user',
          content: [
            ...m.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
            { type: 'text', text: m.content },
          ],
        });
      } else {
        turns.push({ role: m.role, content: m.content });
      }
    }

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
          ...(opts.tools?.length
            ? { tools: opts.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
            : {}),
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
    // tool_use blocks stream their input as JSON fragments; accumulate per
    // block index and emit the complete call at content_block_stop.
    const pendingTools = new Map<number, { id: string; name: string; json: string }>();
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
          case 'content_block_start':
            if (j.content_block?.type === 'tool_use') {
              pendingTools.set(j.index, { id: j.content_block.id, name: j.content_block.name, json: '' });
            }
            break;
          case 'content_block_stop': {
            const pending = pendingTools.get(j.index);
            if (pending) {
              pendingTools.delete(j.index);
              let args: Record<string, unknown> = {};
              try {
                args = pending.json ? JSON.parse(pending.json) : {};
              } catch { /* malformed input json — surface the empty call */ }
              yield { type: 'tool_call', call: { id: pending.id, name: pending.name, args } };
            }
            break;
          }
          case 'content_block_delta':
            if (j.delta?.type === 'text_delta' && j.delta.text) {
              yield { type: 'text', text: j.delta.text };
            } else if (j.delta?.type === 'input_json_delta') {
              const pending = pendingTools.get(j.index);
              if (pending) pending.json += j.delta.partial_json ?? '';
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
