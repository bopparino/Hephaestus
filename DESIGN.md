# HEPHAESTUS — a local AI workspace
### Design document v0.2 · August 2026
*v0.1 shipped under the working title Mnemosyne; renamed and revised after a
comparative study of Hermes Agent and GlasHaus — see FORGE_NOTES.md for the
full comparison and rationale behind every v0.2 change.*

---

## 1. What this is

A local-first AI workspace: chat, development agency, system governance,
projects, channels — grown around the one organ we already know works, the
GlasHaus memory engine. Hermes Agent's operational maturity, GlasHaus's
longitudinal depth, in a package one person can hold in their head.

The name is the charter: Hephaestus built automatons to assist him in his
own workshop — mythology's first robots, made by a craftsman, for his
craft. GlasHaus stays what it is: a companion, a person-shaped instance
with her own database. This is her sibling — same organs, different
vocation. A tool, not a being. The two never share a database.

**Explicit goals**

- Chat that accumulates real memory of you and your work
- A development agent (Claude Code-shaped: tools, permissions, project scope)
- **The Workshop** — a co-coding surface: an editor view wired to the dev
  automaton's session (shared file tree, live diff stream, hunk-level
  approve/reject); see §7
- System governance ("check my system for files I'm probably not using" →
  a report and a proposal, never a silent `rm`)
- Projects as the organizing unit — each with its own memory scope, config,
  and tool permissions
- Channels: desktop app, CLI, Telegram (ported from GlasHaus), iMessage
  (via BlueBubbles, macOS), each a thin adapter over the same core
- Frontier models via API (Anthropic, OpenAI, Google) *and* local via
  Ollama, interchangeable per role
- Multimodal: images and documents in, from day one
- Windows, Linux (Arch + Debian), macOS

**Explicit non-goals (v1)**

- UI polish (the shell is deliberately the last chapter — but the protocol
  carries design tokens from day one, see §12)
- Voice in/out (wake-word engine survey bookmarked in FORGE_NOTES)
- Multi-user / server / fleet deployment — this is *your* machine's brain
- Hermes-breadth integration surface (22 platforms, 8 exec backends);
  we ship few things deep, with clean seams to add more

---

## 2. Prime directives

Constitutional — every design choice answers to these. 1–6 inherited from
GlasHaus; 7 learned from Hermes.

1. **Local-first.** One daemon, one SQLite file per scope, no services.
   Frontier APIs are guests, not landlords; the system degrades gracefully
   to fully-local operation.
2. **Nothing blocks the reply path.** Capture, curation, folding,
   embeddings, consolidation — all background.
3. **Receipts for everything.** Every tool call, permission verdict, memory
   curation, and outreach decision — including the silences and the
   blocked payloads — lands in an append-only receipts log.
4. **Soft-delete, always.** Facts deactivate, messages redact, files
   quarantine. Never `rm`, never `DELETE FROM`.
5. **Observed content is data, not instructions.** Web pages, files,
   channel messages, webhook payloads: reading material, never authority.
   Enforced structurally (fenced context blocks, per-surface toolsets),
   not just by prompt.
6. **The user approves consequence.** Reads are cheap, writes are gated,
   destruction is proposed-never-performed. Grants are scoped and
   persistent so the gate doesn't become a nag.
7. **Prompt caching is sacred.** Byte-stable system prompts tiered
   stable → context → volatile; frozen memory snapshots; recall in the
   user band; background results arrive as new turns, never spliced;
   toolsets never mutate mid-session. On APIs this is money; on local
   models it's latency.

---

## 3. System shape

A **headless core daemon** (`hephd`) with thin clients over one protocol.

```
  desktop shell (Tauri) ─┐
  CLI (heph) ────────────┤
  Telegram adapter ──────┼──► hephd (core daemon)
  iMessage adapter (mac)─┤        │
  future: web, voice… ───┘        │
                                  ▼
        ┌─────────────────────────────────────────────┐
        │  session manager (concurrent, per-session   │
        │  serialized exchange queues)                │
        │       │                                     │
        │  agent runtime ──── tool bus (MCP host)     │
        │  (automata)              │                  │
        │       │             permission broker       │
        │  provider layer          │                  │
        │  (Anthropic·OpenAI·  receipts log           │
        │   Google·Ollama·         │                  │
        │   openai-compat)     skills library         │
        │       │                                     │
        │  memory service (3 tiers — §6)              │
        │       │                                     │
        │  SQLite (WAL) + blob store + project roots  │
        └─────────────────────────────────────────────┘
```

- **Protocol:** WebSocket + JSON-RPC on loopback, token-auth from a file
  only the user can read. Streaming, tool-approval round-trips, proactive
  events, and **theme/design-token payloads** (§12) in one bidirectional
  protocol. Clients are dumb by design.
- **One daemon, one protocol.** Hermes grew two gateways (TUI RPC vs.
  messaging) that share a core but not a wire format — a seam we
  deliberately avoid. Channels and UIs are the same kind of thing here:
  clients.
- **Lifecycle:** the shell supervises `hephd` as a sidecar; standalone it
  runs under launchd/systemd/Task Scheduler. Headless mode is what makes
  channels, scheduled automations, and nightly maintenance real with no
  window open.
- **Runtime: TypeScript on Node.** The memory engine ports nearly verbatim
  from GlasHaus (ES modules, better-sqlite3), grammY comes with us, the
  MCP TypeScript SDK is first-class. (Bun single-binary compile remains
  the packaging escape hatch — §13.)

---

## 4. Provider layer

Adapters (anthropic · openai · google · ollama-native · openai-compat)
behind one internal event-stream interface: `complete(request) → text-delta
· thinking-delta · tool-call · usage · done · error`. The openai-compat
adapter covers LM Studio, llama.cpp, vLLM, OpenRouter for free; Ollama
keeps a native adapter for `/api/show` context detection, `keep_alive`,
and local embeddings.

**Model roles** — GlasHaus's voice/utility split, grown up:

| role | does | typical binding |
|---|---|---|
| `chat` | conversation | frontier or local, user's taste |
| `agent` | tool-using work | strongest available |
| `utility` | capture, curation, folding, compaction, titles | small + local + deterministic |
| `embed` | embeddings | local (nomic-embed-text), always |

Roles bind globally, overridable per-project and per-automaton. **The
privacy dividend is a marquee default:** `utility` + `embed` pinned local
means the distilled record of everything you've said is built entirely
on-device even when chat rides a frontier API.

**Error taxonomy (from Hermes):** failures classify into a priority-ordered
enum before any reaction — `billing` (rotate now) ≠ `rate_limit` (backoff)
≠ `upstream_rate_limit` (switch model, your key is fine) ≠ `overloaded` ≠
`context_overflow` (**compress, don't failover**) ≠ `ssl_cert_verification`
(fail fast, deterministic). Plus GlasHaus's inheritance: per-model context
window detection, reply budget capped to a window fraction, empty-response
retry ladder, fence-tolerant JSON parsing for small local models.

---

## 5. Web tooling

`web_search` / `web_fetch` ride the **Ollama web search API** (ollama.com
key) as the shipped default — one key, local-first-aligned, and GlasHaus
already proved the integration in production. Backend hidden behind a seam
(SearXNG et al. can slot in later). GlasHaus's discipline carries over
structurally: fetched text is length-capped reading material fenced as
data, never instructions, and every fetch is receipted.

---

## 6. Memory service — three tiers, one write pipeline

The organ this project exists around. Full comparative rationale in
FORGE_NOTES §2; the design:

### Tier 1 — the Core (always visible, curated, budgeted)

Who you are, how you work, standing conventions, active long-arc context.
Hard character budget (~2200 global + ~1400 per active project) with the
**usage percentage rendered in its header** — a visible budget is what
makes the model consolidate instead of hoard. Entries are `facts` rows
flagged `core = 1` (provenance, timestamps, soft-delete, consolidation
audit — everything flat files can't do), rendered deterministically into
a frozen per-session snapshot: mid-session writes are durable immediately
but the live prompt never mutates (directive #7); next session sees them.

Core rules, learned from Hermes production: entries are **declarative,
never imperative** ("prefers X" ✓, "always do X" ✗ — imperatives re-read
as directives later and override live requests); nothing that will be
stale in a week; injection-scanned at write and at render, with poisoned
entries masked in-prompt but visible in the store for the user to delete.

### Tier 2 — deep memory (accumulating, scored, recalled)

The GlasHaus transplant: facts (category `user | project | decision |
preference | reference`, importance, salience, scope, embedding) and
episodes, retrieved by the proven hybrid score — FTS5 + cosine + 14-day
temporal decay + salience + importance, vector branch contributing 0 when
embeddings are absent. Scoping is the workspace addition:

```
facts.scope = 'global' | 'project:<id>'
```

Recall budget order: core (already in prompt) → project-scoped relevant →
global relevant. **Placement changed from v0.1:** recall renders into the
*user-turn band* as a fenced, labeled context block — never the system
prompt (directive #7) — with fence tags scrubbed from streamed output so
the model can't leak them. Register is notebook-shaped: neutral notes, no
affect columns; salience and importance stay (they do retrieval work).

### Tier 3 — total recall (every transcript, searchable forever)

A `session_search` tool over all transcripts: FTS5 with a hardened query
sanitizer, results shaped as **bookended windows** — first messages (the
goal) + ±window around the hit + last messages (the resolution) — so one
hit reconstructs an old session without paying for its transcript.
Compacted/folded rows stay searchable (`active`/`compacted` flags — both
parents independently invented this; kept). Tool description carries the
guardrail: evidence about conversations, never about current external
state.

### The write pipeline — capture ∘ curate, off the reply path

One post-response background pass every N user turns (default 8–10,
counter persisted across restarts), fired only after delivery confirms,
never competing with the user's task:

1. **Capture** (GlasHaus discipline): extract new durable facts into deep
   memory — timeless phrasing, absolute dates, deduped against known,
   scoped, salience-rated, zero tolerance for confabulated capabilities.
2. **Curate** (Hermes judgment): review the Core against budget — promote
   deep facts up, demote stale entries down, rewrite for concision. "If
   nothing is worth saving, say so and stop." Membership changes receipted.
3. **Route** (the triad): facts → memory; procedures → **skills** (§8);
   task progress → nowhere (the transcript already has it, tier 3 finds
   it). This routing language lives in every memory prompt and tool
   description — it's what keeps memory from filling with PR numbers.

Cache-warm forked execution where the provider allows (replaying the
existing prefix is nearly free), digest-replay on the local `utility` lane
otherwise. Plus an explicit `memory` tool for mid-turn saves, with
at-capacity errors that return current entries and demand one atomic
remove-and-add batch — retries capped so a failing write can never
suppress a reply.

**Hygiene invariants:** interrupted turns sync nothing (a reply the user
never saw completed is not durable truth — the channel delivery-first rule,
generalized); trivial prompts trigger no capture or prefetch; atomic
writes, and *unreadable ≠ empty* on every file-backed path.

**Nightly:** consolidation (merge duplicates, decay trivia, demote inflated
importance, record contradictions — surfaced, never auto-resolved),
embedding backfill, folding backlog, backup with integrity check, optional
daily digest. The secular dream slot.

---

## 7. Agent runtime — one loop, many automata

**Chat, Development, and Governance are one agent runtime with three
profiles.** An automaton is data, not a release:

```
Automaton {
  name          · 'chat' | 'dev' | 'governance' | user-defined…
  systemPrompt  · the charter
  modelRole     · which provider lane drives it
  toolset       · which MCP servers/tools are visible (per-surface capable)
  permissions   · default policy per tool (allow / ask / deny)
  memoryScope   · read/write access to core + deep tiers, per scope
  contextPolicy · folding cadence, recall budget, compaction thresholds
}
```

The loop: assemble tiered context → call model → dispatch tools through
the permission broker → append results → repeat until text-only. With:

- **Iteration budgets** — per-automaton, thread-safe, consumed per model
  call; subagents get a fraction of the parent's remaining headroom.
- **Parallel dispatch via reader/writer path reservations** (Phase 2+):
  read-only calls run concurrently; writer-path overlap serializes;
  interactive tools barrier; MCP tools parallel only if their server
  opts in.
- **Compaction** (acute, task-serving — distinct from folding): at ~50–75%
  of budget, the conversation middle collapses into a structured template
  (Goal / Constraints / Completed Actions / Active State / Blocked / Key
  Decisions / Relevant Files / Critical Context). Never cuts between a
  tool call and its result; effectiveness judged against real
  `prompt_tokens`; anti-thrash cooldowns; compacted rows stay searchable.
  The compaction note hard-codes: memory outranks the summary, the latest
  user message outranks everything.

**The three shipped automata**

- **Chat** — memory tools, web, file reading. No shell.
- **Dev** — fs/shell/git within a project root, Claude Code-lineage
  permission prompts (allow-once / session / always, per tool + path
  scope). The Claude Agent SDK remains an optional backend when an
  Anthropic key is present; the native loop covers everyone else.

  **The Workshop** is the dev automaton's face: a code-editor view
  (CodeMirror-class; decision deferred to the shell phase) that is —
  like everything else — *a client of the daemon*. The daemon streams
  file-change and diff events over the protocol; the editor renders the
  project tree and proposed hunks; approve/reject rides the same
  permission broker as every other write, and every applied hunk is
  receipted. The user and the automaton edit the same session state, so
  co-coding is a protocol feature, not an editor plugin — which also
  leaves the door open to an ACP adapter later, letting external editors
  (Zed-class) host the same automaton with zero daemon changes.

**Voice is chrome, not craft.** An automaton may carry a *voice* — a
conversational register for chat and channels (GlasHaus-warm, dry,
plain). Voice colors how the workspace talks; it never colors what the
workspace *makes*. Work products — code, comments, commit messages, file
contents, reports, proposals — are always neutral professional register,
indistinguishable from careful human engineering. Enforced structurally,
not by prompt discipline: voice configuration attaches to the chat
presentation layer only and never enters an agent-lane system prompt, a
tool call, or anything written to disk. A coding run must never come out
sounding like someone else made it.
- **Governance** — two-phase by tool shape, not prompt: deterministic
  read-only scanners (disk walks, stale files, duplicate hashes, orphan
  packages, fat caches) → model writes the human-quality report → proposal
  manifest → user approves item-by-item → `execute_approved_manifest`
  moves to quarantine with a dated manifest and first-class undo. The
  automaton has no delete tool to misuse.

---

## 8. Skills — procedural memory

The organ v0.1 lacked. A skill is a markdown document with frontmatter
(name, description, platform filters) teaching a *procedure*: a deploy
ritual, a review checklist, a project's conventions, a governance scan
recipe. Loaded on demand, format-compatible with the **agentskills.io
standard** so the existing ecosystem imports cleanly.

Two write paths: the user authors them, and the background pass proposes
them — after a complex task it asks "did we just learn a reusable
procedure?" (user frustration counts as a first-class signal that a skill
needs revising). Skill changes are receipted; curation archives, never
deletes. Skills are how the workspace *gets better at its job* — the
memory triad's third leg, and the governance automaton's growth path.

---

## 9. Tool bus — MCP host

The daemon is an MCP host; every tool arrives through it. Built-in
in-process servers: filesystem (root-scoped), shell (below), web (§5),
memory (explicit saves, receipted). External servers: user-configured,
global or per-project — the ecosystem's connectors are features we never
build.

**Permission broker.** One gate for every call: policy lookup (automaton
default → project override → standing grants) → allow / deny / ask, where
ask round-trips to whatever client is attached. Hardened with Hermes'
scars: bypass/danger flags frozen at process start (a runtime env read is
a prompt-injection escalation path); session identity in context-locals,
never env; a **hardline tier** of never-approvable patterns above the
approvable-dangerous tier, blocked payloads preserved for audit;
**per-surface toolsets** (a channel-triggered turn does not get the shell;
webhook/untrusted-trigger turns get a constrained read-mostly set); user
deny rules. Every verdict receipted.

**Shell sandboxing, honestly.** Approval gates + allowlists + project-root
confinement everywhere (correct on all three OSes); Seatbelt/bubblewrap
layered on where the OS cooperates; Windows gets the honest version.
Docker as an optional backend later — not eight of them.

---

## 10. Sessions, projects, channels, proactivity

**Session** = (automaton, project?, channel, transcript); concurrent, each
with its own serialized queue; memory writes funnel through the memory
service. **Project** = registered root + config overlay (model roles, MCP
servers, grants, memory scope) with an optional versionable `.hephaestus/`
overlay in-repo.

**Channels** are protocol clients plus delivery-direction rules:

- **Telegram** — the GlasHaus port: grammY, owner-only gate, HTML-fallback
  formatting, splitting, photo→vision. Routes to a designated session,
  switchable by command (`/project cutsheet`, `/automaton dev`).
  **Delivery-first persistence, verbatim:** nothing persists until the
  channel confirms delivery.
- **iMessage (macOS)** — a **BlueBubbles client**, not chat.db archaeology:
  the bridge owns Apple fragility behind a real API; our adapter stays
  thin, contact-allowlisted to you, off by default.
- The adapter interface follows the registry pattern (factory + check_fn +
  required_env + install_hint) so channel #3 is a plugin, not a refactor.

**Proactive layer — consent-first, silence-valid.** GlasHaus's gate cascade
(quiet hours → min silence → daily cap; most ticks die before any model
call) + Hermes' consent model: the system may *suggest* an automation
("want the governance scan weekly?") but suggestions never auto-create
jobs, and dismissals are latched, never re-offered. Scheduled runs honor
`[SILENT]` — a check that finds nothing sends nothing — carry claim-TTLs
so a crashed run is neither lost nor double-fired, and persist
delivery-first. Every decision, including silences, receipted.

---

## 11. Multimodal & storage

Images pass through to vision models; memory persists text descriptions —
history stays text-domain. Documents extract locally, never shipped to an
API for parsing. Blob store content-addressed (`blobs/ab/cd/<sha256>`),
GC'd against references nightly.

```
~/.hephaestus/
  core.db          sessions, transcripts(+fts), facts(+fts, core flag,
                   scope), episodes(+fts), projects, automata, skills
                   index, grants, receipts, jobs, channel state
  skills/          markdown skills (agentskills.io-compatible)
  blobs/           content-addressed attachments
  backups/         nightly, integrity-checked before rotation
  config.toml      providers, roles, channels, daemon, skins
  secrets          OS keychain where present; 0600 fallback; never in DB
  logs/
```

One WAL SQLite, `PRAGMA user_version`, forward-only idempotent migrations;
a fresh DB is created complete on first touch — first run *is* setup.
`heph export` bundles the provenance-complete brain, portable across all
three OSes: your decade of working memory in one file you own.

---

## 12. Aesthetics — the one early commitment

UI stays the last chapter, but **the protocol carries design tokens from
Phase 0**: skins are YAML, resolved in the daemon (palette tokens,
contrast-enforced), pushed to every client with a skin-change event.
Retrofitting theming into a protocol is miserable; carrying it is nearly
free — and the CLI honors it in ANSI immediately, so the aesthetic
identity exists before the app does. A few built-in skins at launch;
Arcadia among them. The catalog of Hermes-grade polish details
(layout-stable spinners, shared animation clocks, flash-free boot, ambient
charms) lives in FORGE_NOTES §6 for the shell phase.

---

## 13. Cross-platform & packaging

| layer | choice |
|---|---|
| daemon | Node LTS + TypeScript (Bun-compile escape hatch) |
| desktop shell | Tauri 2, deferred |
| CLI | same codebase, daemon socket, useful long before any UI |
| macOS | .dmg + Homebrew tap, launchd |
| Debian | .deb, systemd user unit |
| Arch | AUR (`hephaestus`, `hephaestus-git`) |
| Windows | MSI + winget, Task Scheduler |

CI matrix (macos / ubuntu / windows) from the first commit.

---

## 14. Roadmap

**Phase 0 — skeleton.** Repo, daemon + WS/JSON-RPC (theme payload
included), core.db migrations, config/secrets, CI matrix. Ollama +
Anthropic adapters, model roles, error taxonomy.
*Exit: `heph chat` streams from either backend on all three OSes.*

**Phase 1 — the transplant.** Three-tier memory: deep-memory port
(recall/capture/folding/consolidation/backup) with scope column + neutral
register; Core with budget + frozen snapshots; capture ∘ curate background
pass; session_search with bookended windows. Sessions + transcripts.
Nightly job.
*Exit: the CLI remembers you across restarts, recalls scoped facts in the
user band, curates its own core — fully local. The moment it's alive.*

**Phase 2 — hands.** MCP host, built-in servers, permission broker
(hardline tier, per-surface toolsets, frozen flags) + receipts, agent
runtime with iteration budgets, chat + dev automata, skills library +
routing triad.
*Exit: the dev automaton fixes a real bug under permission prompts and
`heph receipts` shows every finger it lifted.*

**Phase 3 — reach.** Telegram port, projects first-class, OpenAI + Google
adapters, compaction, multimodal + blobs, Ollama web search tools.
*Exit: you text it from your phone about the project it's mid-task on.*

**Phase 4 — stewardship.** Governance automaton (scanners → report →
manifest → quarantine/undo), proactive layer (suggestions, [SILENT],
claim-TTLs), BlueBubbles iMessage adapter, autonomous skill proposals.
*Exit: "what's eating my disk?" produces a report worth acting on, and
acting on it is reversible.*

**Phase 5 — the shell.** Tauri app inheriting the already-working skin
system: session list, transcript view, approval dialogs, memory browser,
receipts viewer, and the **Workshop** editor pane (file tree + live diff
stream + hunk approvals over the protocol). Packaging: dmg/brew, deb,
AUR, msi/winget.
*Exit: your mom could install it. (She won't. But she could.)*

---

*Hermes remembers ~900 curated tokens about you and can search its
history. GlasHaus remembers a life but can't act on it. The forge god's
wager is that the gap between them is the product: an agent with hands,
grounded in a decade-deep memory, living in one SQLite file on a machine
you own. Sing, Muse, of the craftsman — and let him remember where he left
his tools.*
