import { randomUUID } from 'node:crypto';
import { getDb, receipt } from './db.js';
import type { Risk } from './tools.js';

// The permission broker — one gate for every tool call (DESIGN §9), carrying
// the Hermes scars as invariants:
//  - the danger-bypass flag is read ONCE at process start: a runtime env
//    read would let anything running in-process flip it (injection escalation)
//  - a hardline tier sits ABOVE the approvable tier: some things are never
//    a question, and the blocked payload is preserved for audit
//  - every verdict is receipted, including the denials

const YOLO_FROZEN = process.env.HEPHAESTUS_YOLO === '1'; // read once, by design

// Never approvable. Tight on purpose — a hardline list that catches too
// much teaches users to route around the broker entirely.
const HARDLINE: { name: string; test: RegExp }[] = [
  { name: 'rm-rf-root', test: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~\/?)(\s|$)/i },
  { name: 'no-preserve-root', test: /--no-preserve-root/i },
  { name: 'sudo', test: /\bsudo\b/ },
  { name: 'curl-pipe-shell', test: /\b(curl|wget)\b[^|;&]*\|\s*(ba|z|da)?sh\b/i },
  { name: 'mkfs', test: /\bmkfs\b/ },
  { name: 'dd-device', test: /\bdd\b.*\bof=\/dev\// },
  { name: 'fork-bomb', test: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/ },
  { name: 'chmod-root', test: /\bchmod\b.*\s(\/|~\/?)(\s|$)/ },
];

export type Decision = 'allow' | 'deny' | 'ask';
export type GrantScope = 'session' | 'always';

export interface AskRequest {
  approvalId: string;
  sessionId: number;
  tool: string;
  risk: Risk;
  summary: string;
}

type Asker = (req: AskRequest) => void;

interface PendingAsk {
  resolve: (d: 'allow-once' | 'allow-session' | 'allow-always' | 'deny') => void;
  sessionId: number;
  tool: string;
}

export class PermissionBroker {
  private pending = new Map<string, PendingAsk>();
  private sessionGrants = new Map<number, Set<string>>();

  hardlineCheck(tool: string, args: Record<string, unknown>): string | null {
    if (tool !== 'shell') return null;
    const cmd = String(args.command ?? '');
    for (const rule of HARDLINE) {
      if (rule.test.test(cmd)) {
        // Preserve the blocked payload — audit trail, not a black hole.
        receipt('permission_hardline', { tool, rule: rule.name, payload: cmd.slice(0, 500) });
        return rule.name;
      }
    }
    return null;
  }

  private standingGrant(sessionId: number, tool: string): boolean {
    if (this.sessionGrants.get(sessionId)?.has(tool)) return true;
    const row = getDb()
      .prepare("SELECT id FROM grants WHERE tool = ? AND scope = 'always' AND revoked = 0")
      .get(tool);
    return !!row;
  }

  grant(sessionId: number, tool: string, scope: GrantScope): void {
    if (scope === 'session') {
      if (!this.sessionGrants.has(sessionId)) this.sessionGrants.set(sessionId, new Set());
      this.sessionGrants.get(sessionId)!.add(tool);
    } else {
      getDb().prepare('INSERT INTO grants (tool, scope) VALUES (?, ?)').run(tool, 'always');
    }
    receipt('permission_grant', { tool, scope }, sessionId);
  }

  /** The gate. Returns 'allow' | 'deny'; 'ask' resolves through the client. */
  async check(
    sessionId: number,
    tool: string,
    risk: Risk,
    args: Record<string, unknown>,
    ask: Asker | null,
  ): Promise<{ allowed: boolean; via: string }> {
    const hardline = this.hardlineCheck(tool, args);
    if (hardline) return { allowed: false, via: `hardline:${hardline}` };

    if (risk === 'read') return { allowed: true, via: 'risk:read' };
    if (YOLO_FROZEN) return { allowed: true, via: 'yolo-frozen-at-boot' };
    if (this.standingGrant(sessionId, tool)) return { allowed: true, via: 'grant' };
    if (!ask) return { allowed: false, via: 'headless-deny' };

    const approvalId = randomUUID();
    const summary =
      tool === 'shell' ? String(args.command ?? '').slice(0, 200)
      : tool === 'fs_write' ? `write ${String(args.path ?? '?')} (${String(args.content ?? '').length} chars)`
      : JSON.stringify(args).slice(0, 200);

    const decision = await new Promise<'allow-once' | 'allow-session' | 'allow-always' | 'deny'>(resolvePromise => {
      this.pending.set(approvalId, { resolve: resolvePromise, sessionId, tool });
      ask({ approvalId, sessionId, tool, risk, summary });
      // A gate that hangs forever is a gate someone disables — deny on timeout.
      setTimeout(() => {
        if (this.pending.delete(approvalId)) resolvePromise('deny');
      }, 120_000).unref?.();
    });

    if (decision === 'allow-session') this.grant(sessionId, tool, 'session');
    if (decision === 'allow-always') this.grant(sessionId, tool, 'always');
    return { allowed: decision !== 'deny', via: `ask:${decision}` };
  }

  respond(approvalId: string, decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny'): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) return false;
    this.pending.delete(approvalId);
    pending.resolve(decision);
    return true;
  }
}
