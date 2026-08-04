// The provider seam: four adapters eventually, one event stream always.

export type ModelRole = 'chat' | 'agent' | 'utility' | 'embed';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant turns that requested tools */
  toolCalls?: ToolCall[];
  /** tool turns: which call this result answers */
  toolCallId?: string;
  toolName?: string;
}

/** Model-facing tool description — JSON Schema parameters, provider-mapped
 *  by each adapter. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; input?: number; output?: number }
  | { type: 'done' };

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** false disables reasoning where supported — the utility lane's setting:
   *  thinking models can burn the whole budget reasoning and emit nothing. */
  think?: boolean;
  tools?: ToolSpec[];
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly name: string;
  chat(model: string, messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<StreamEvent>;
  listModels?(): Promise<string[]>;
  /** Turn aliases ("auto") into the concrete model — receipts record truth. */
  resolveModel?(model: string): Promise<string>;
}

// FORGE_NOTES §4.2 — classify before reacting. The distinctions are
// load-bearing: billing rotates now, rate_limit backs off, context_overflow
// compresses instead of failing over, ssl fails fast.
export type FailReason =
  | 'auth'
  | 'billing'
  | 'rate_limit'
  | 'upstream_rate_limit'
  | 'overloaded'
  | 'context_overflow'
  | 'payload_too_large'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad_request'
  | 'unknown';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly reason: FailReason,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function classifyHttp(status: number, body: string): FailReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 408) return 'timeout';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limit'; // upstream_rate_limit needs aggregator context — Phase 3
  if (status === 400) {
    return /context|too long|maximum.*tokens|exceeds/i.test(body) ? 'context_overflow' : 'bad_request';
  }
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  return 'unknown';
}

export function isRetryable(reason: FailReason): boolean {
  return reason === 'network' || reason === 'server' || reason === 'overloaded' || reason === 'timeout';
}

export function asProviderError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const reason: FailReason = /abort|timeout/i.test(msg) ? 'timeout' : 'network';
  return new ProviderError(`${provider}: ${msg}`, reason);
}
