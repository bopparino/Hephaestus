// The one wire format. Every client — CLI, shell, channel adapters — speaks
// this over WebSocket to hephd. Requests carry an id; events don't.

export const PROTOCOL_VERSION = 0;

export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcError {
  // codes are the provider FailReason strings plus daemon-level codes
  // ('bad_request', 'not_found', 'internal')
  code: string;
  message: string;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: RpcError;
}

/** Server-push notification (no id, never replied to). */
export interface RpcEvent {
  event: string;
  params: Record<string, unknown>;
}

export type Frame = RpcRequest | RpcResponse | RpcEvent;

// ---- events -----------------------------------------------------------------
// chat.delta   { reqId, text }          streamed model output
// chat.done    { reqId, sessionId, usage }
// skin.changed { skin: ResolvedSkin }   broadcast on skins.set

// ---- skins ------------------------------------------------------------------

export interface SkinPalette {
  bg: string;
  bgAlt: string;
  surface: string;
  border: string;
  fg: string;
  fgMuted: string;
  accent: string;
  accentAlt: string;
  positive: string;
  warning: string;
  danger: string;
  info: string;
}

export interface Skin {
  name: string;
  label: string;
  polarity: 'dark' | 'light';
  palette: SkinPalette;
  verbs?: string[];
}

export interface ResolvedSkin extends Skin {
  resolved: {
    /** black or white — whichever reads on the accent. */
    fgOnAccent: string;
    /** tokens the contrast pass had to lift (informational). */
    contrastLifted: string[];
  };
}

// ---- daemon state file (~/.hephaestus/daemon.json) --------------------------

export interface DaemonState {
  pid: number;
  port: number;
  startedAt: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}
