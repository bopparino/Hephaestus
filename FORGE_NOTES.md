# FORGE NOTES — Hermes Agent vs. GlasHaus, and the Hephaestus middle ground
### Companion to DESIGN.md · August 2026
*Notes from studying another god's forge before lighting our own.*

Sources: full read of the GlasHaus source, and a three-way deep sweep of
`nousresearch/hermes-agent` (memory/state internals, agent runtime/tools/
providers, TUI/gateway/channels). Hermes is ~1.47M lines of Python plus a
TypeScript TUI — a genuine platform. This document is what we take, what we
adapt, and what we deliberately refuse.

---

## 1. The two poles

**GlasHaus is organism-shaped.** One process, one SQLite file, one
consciousness. Its genius is *longitudinal depth*: everything ever said is
kept, folded, distilled, consolidated, and recalled with a scoring function
tuned over months. Memory is large and retrieved selectively.

**Hermes is infrastructure-shaped.** Gateway to 22 messaging platforms,
8 terminal execution backends, 33 provider profiles, plugins, skills hub,
cron, kanban, voice, a vendored fork of Ink. Its genius is *operational
maturity*: every subsystem carries scars from production (frozen YOLO flags,
drift detection, orphan reapers, claim TTLs). Memory is tiny and curated.

The poles disagree most interestingly about memory, and that disagreement
is where Hephaestus lives:

| | GlasHaus | Hermes | Hephaestus |
|---|---|---|---|
| memory store | SQLite facts + episodes, thousands of rows | two markdown files, **~900 tokens total**, hard char caps | both, tiered (§2) |
| who writes it | system-driven capture pass (model as extractor) | the agent itself, via a `memory` tool | both, one background pass (§2.4) |
| how it's read | hybrid-scored recall per exchange | full injection, frozen per-session snapshot | core injected; deep memory recalled (§2) |
| past transcripts | folded into episodes, then only reachable via recall | FTS5 `session_search` tool, bookended result windows | adopt Hermes' tool wholesale (§2.3) |
| embeddings | yes, graceful-absence hybrid | none anywhere | GlasHaus wins — vector branch that degrades to 0 |
| prompt caching | rebuilt system prompt every exchange (fine for Ollama) | **sacred** — byte-stable prompts, snapshot semantics | Hermes wins — see §4.1, this changes our recall placement |

---

## 2. Memory — the synthesis

This is the heart of the middle ground. Hephaestus memory has **three tiers
with distinct read paths, one write pipeline**.

### 2.1 Tier 1 — the Core (Hermes-style read, GlasHaus-style storage)

A small, curated, always-visible working memory: who you are, how you work,
standing conventions, active long-arc context. Hard character budget
(start at Hermes' ~2200 global + ~1400 per-project), **usage percentage
rendered in the header** — Hermes' trick of making the budget visible is
what makes the model consolidate instead of hoard.

But unlike Hermes, entries are not lines in a flat file — they're rows in
`facts` flagged `core = 1`, rendered deterministically into the prompt
block. We keep provenance, timestamps, soft-delete, and consolidation
audit over core entries; Hermes' flat files give up all four. GlasHaus's
"importance ≥ 9 stable core" becomes an *explicitly curated* set rather
than an emergent one — same churn-prevention goal, deliberate membership.

**Snapshot semantics (adopt exactly):** the core is frozen per-session at
assembly time. Mid-session writes hit the DB immediately (durable) but do
not mutate the live prompt — the prefix cache survives the whole session;
the next session sees the update. Hermes' docstring states the tradeoff
honestly and it's the right one.

**Rules adopted verbatim from Hermes' prompts:**
- *Declarative, not imperative.* "User prefers concise responses" ✓,
  "Always respond concisely" ✗ — imperative entries get re-read as
  directives later and override live requests. This is a production scar,
  not a style opinion.
- *"If a fact will be stale in a week, it does not belong in memory."*
- Injection scan at write **and** at snapshot render; a poisoned entry is
  masked in the prompt but left visible in the store so the user can see
  and delete it.

### 2.2 Tier 2 — Deep memory (GlasHaus, with one placement change)

The accumulating store: facts with category/importance/salience/scope,
episodes from folding, hybrid recall (FTS5 + cosine + 14-day temporal decay
+ salience + importance, vector branch contributing 0 when embeddings are
absent). This ports from GlasHaus as designed in DESIGN.md §6.

**The placement change, learned from Hermes:** recalled facts do NOT go in
the system prompt. GlasHaus rebuilds its prompt every exchange — correct
for a local-only companion, ruinous for frontier-API prompt caching. Recall
renders into the *user-turn band* as a fenced, clearly-labeled context
block (Hermes fences external memory as `<memory-context>` and scrubs the
fence tags from streamed output so the model can't leak them — adopt both
halves). System prompt stays byte-stable; recall stays fresh; caching
stays intact. This is a strict improvement over both parents.

### 2.3 Tier 3 — Total recall (Hermes, adopted wholesale)

Every transcript searchable forever via a `session_search`-class tool.
Hermes' result shape is the part to copy carefully: a hit returns
*bookend_start* (first messages = the goal) + *window* (±5 around the
match) + *bookend_end* (last messages = the resolution) — one hit
reconstructs goal → match → resolution without paying for the transcript.
Their FTS5 query sanitizer (balanced-quote preservation, operator
stripping, auto-quoting dotted terms so `my-app.config.ts` doesn't explode
into implicit ANDs) is a solved problem; port the approach.

Also adopt the tool-description guardrail: session search is evidence about
*conversations*, not about the current state of external sources — "not
found in past sessions" must never masquerade as "not found."

GlasHaus already keeps every message and flags them `summarized` — the
archive exists; Hermes shows how to make it a first-class surface.

### 2.4 One write pipeline — capture ∘ curate

Austin's favorite Hermes mechanism, examined: after the reply is delivered,
every N user turns (default 10), Hermes **forks the agent on a background
thread** — inheriting the exact runtime so it re-hits the same prompt
prefix cache, making the review nearly free — replays the conversation, and
asks: *did the user reveal preferences, corrections, expectations worth
saving? If nothing, say "Nothing to save." and stop.* Whitelisted to memory
tools only, capped iterations, auto-deny on anything dangerous.

GlasHaus's capture pass is the same *slot* (post-exchange, off the reply
path, every N=8) with the opposite temperament: systematic structured
extraction — timeless phrasing, absolute dates, dedup against known facts,
strict no-confabulated-capabilities rules, salience ratings.

**Hephaestus fuses them into one post-response background pass:**

1. **Capture** (GlasHaus discipline): extract new durable facts into deep
   memory — timeless, deduped, scoped (global vs project), salience-rated.
2. **Curate** (Hermes judgment): review the Core against its budget —
   promote a deep fact to core, demote stale core entries back to
   deep-only, rewrite for concision. Core membership changes are receipted.
3. Cache-warm where the provider supports it (fork with identical prefix),
   digest-replay where it doesn't (Hermes does exactly this split when the
   review routes to a cheaper aux model — and so will we, since our
   `utility` role pins local).

Plus the explicit `memory` tool for mid-turn saves ("remember this"), with
Hermes' at-capacity behavior: the error returns current entries and demands
one atomic remove-and-add batch, retries capped so a failing memory write
can never suppress the user's reply.

**Write-path hygiene adopted from Hermes** (their scars, our vaccine):
- Interrupted turns sync nothing — a partial reply the user never saw
  completed must not become remembered truth. (GlasHaus's delivery-first
  Telegram rule is the same theorem for channels; now it holds everywhere.)
- Trivial prompts ("ok", "thanks", "continue") don't trigger recall
  prefetch or capture.
- Atomic temp+rename writes, lock files, and *unreadable ≠ empty* — a
  store that exists but can't be read aborts the write rather than
  rewriting from an assumed-empty view. (SQLite gives us most of this
  free; the sentinel discipline still applies to config and export paths.)

### 2.5 What memory is NOT — the routing triad

Hermes' sharpest organizational idea: **memory, skills, and session search
are three explicit destinations, and the prompts actively route between
them.** Procedures belong in a skill, not memory. Task progress belongs in
the transcript (searchable later), not memory. Facts about the user belong
in memory, not a skill. Most systems collapse these and end up with memory
files full of PR numbers. The routing language goes into our capture/curate
prompts and every memory-tool description from day one.

---

## 3. Context management — folding and compaction are different organs

The comparison clarified something DESIGN.md v0.1 blurred. GlasHaus
*folding* and Hermes *compaction* look similar (old messages → summary) but
serve different masters:

- **Folding** (GlasHaus) serves *memory*: chunks become episodes — affect-
  tagged, embedded, retrievable months later. Chronic, gentle, off-path.
- **Compaction** (Hermes) serves *the live task*: at ~50-75% of the context
  budget, the middle of the conversation collapses into a structured
  template — Goal / Constraints & Preferences / Completed Actions
  (numbered, `N. ACTION target — outcome [tool: name]`) / Active State /
  Blocked / Key Decisions / Resolved Questions / Relevant Files / Critical
  Context. Acute, surgical, on-path.

Hephaestus does **both**: compaction for agent sessions under pressure
(a dev automaton three hours into a refactor needs its goal and decisions
crisp, not its history poetic), folding for chat history as it ages (the
workspace needs to remember *that week*, not re-derive it). Details adopted
from Hermes' compactor:

- **Never cut between a tool call and its result** — boundary snapping.
- Judge effectiveness against the provider's *real* `prompt_tokens` on the
  next call, not message-list shrinkage (system prompt + tool schemas are
  an incompressible floor).
- Anti-thrash: two consecutive low-yield passes → back off; summarizer
  429 → cooldown.
- Compacted rows stay **searchable forever** — Hermes marks
  `active=0, compacted=1` and session search includes them; GlasHaus
  independently invented the same flag (`summarized`). Convergent evolution
  is strong evidence; keep it.
- The compaction note hard-codes that persistent memory **outranks** the
  compaction summary, and that the latest user message wins over anything
  in it. Memory > compaction > nothing.

---

## 4. The agent loop — what 1.47M lines of production Python teaches

### 4.1 Prompt caching is sacred → promoted to Prime Directive #7

Hermes' AGENTS.md states it as an invariant and half their odd-looking code
exists to serve it: nothing mutates past context, toolsets stay byte-stable
mid-session, background results arrive as a *new turn* rather than being
spliced between a tool result and an assistant message, the system prompt
is tiered stable → context → volatile so a change re-prefills only from its
band down, and even the prompt's timestamp is date-only so it stays
byte-stable for a day. For us this decides: frozen core snapshots (§2.1),
recall in the user band (§2.2), delegation results as new turns, and no
mid-session toolset swaps. On frontier APIs this is directly money; on
local models it's latency. Both matter.

### 4.2 Error taxonomy for the provider layer

Hermes classifies failures into a priority-ordered enum before reacting,
and the distinctions are load-bearing: `billing` (402 — rotate now) vs
`rate_limit` (429 — backoff then rotate) vs `upstream_rate_limit`
(aggregator's 429 — switch *model*, your key is fine) vs `overloaded` vs
`context_overflow` (**compress, don't failover**) vs `ssl_cert_verification`
(fail fast, deterministic per host). Our provider layer adopts the taxonomy
on day one — GlasHaus's retry ladder is the right instinct at one-provider
scale; this is what it grows into at four.

### 4.3 Parallel tool dispatch: reader/writer path reservations

Hermes' segment planner lets read-only tool calls run concurrently while
any writer-path overlap forces sequencing — with patch targets parsed from
the patch body, not a stale arg. MCP tools join parallel runs only if their
server opted in. We adopt the *model* (plan segments; readers parallel,
writers serialize, interactive tools barrier) in Phase 2, simple version
first.

### 4.4 The narrow waist

Every core tool costs schema tokens on every call, so Hermes keeps the core
tool list small and pushes capability to the edges: gated tools, skills,
plugins. Their `project_*` tools exist only in the GUI toolset; webhook-
triggered turns get a deliberately constrained toolset because webhook
payloads carry untrusted third-party text. Both principles transfer
directly: **per-surface toolsets** (a Telegram-triggered turn does not get
the shell) and **untrusted-trigger lockdown** land in our permission broker
design now, not later.

### 4.5 Approval-system scars, inherited as invariants

Three Hermes lessons that cost them CVEs/incidents, free for us:
- Danger-bypass flags are read **once at process start** — a runtime env
  read would let anything running in-process flip it (prompt-injection
  escalation path).
- Session identity and interactive state live in context-locals, never
  env vars — concurrent sessions sharing a process raced on env mutation
  and one session's cleanup dropped another onto the auto-approve path.
- A **hardline tier** of never-approvable patterns above the approvable-
  dangerous tier, with blocked payloads preserved to disk for audit.
Our permission broker speaks these natively, and our receipts log (Prime
Directive #3) already wants the blocked-payload audit trail.

### 4.6 Iteration budgets, refunds, and programmatic tool calling

Per-agent iteration budgets (thread-safe, consumable, refundable) cap
runaway loops; subagents get a fraction of the parent's remaining headroom.
And `execute_code` — the model writes a script that calls tools via RPC,
with only the script's *stdout* entering context — collapses multi-step
pipelines into zero-context-cost turns. Budgets land in Phase 2;
execute_code is a Phase 4+ delight worth keeping on the map.

---

## 5. Skills — the organ v0.1 was missing

DESIGN.md v0.1 had profiles (identity) and memory (facts) but nothing for
*procedures* — and Hermes demonstrates that's a real, separate kind of
remembering: markdown documents with frontmatter, platform filters, an
installable hub with provenance and quarantine, curation that archives but
never deletes, and — the striking part — **autonomous skill creation**: the
same background review that curates memory asks "did we just learn a
procedure worth keeping?", treats user frustration as a first-class signal,
and writes the skill. That's the "self-improving" in their tagline, and
mechanically it's just our capture ∘ curate pass with a third destination.

Hephaestus adopts skills in Phase 2 (format-compatible with the
agentskills.io standard so the existing ecosystem imports cleanly), and the
background pass gains destination #3: facts → memory, history → search,
**procedures → skills**. The governance automaton's scanners-then-report
patterns, Austin's deploy rituals, per-project conventions — these are
skills, not memories, and now they have somewhere to live.

---

## 6. Aesthetics — decomposing "it feels good"

The TUI's charm is not one decision; the sweep found it's a hundred small
correctness choices. Cataloged for our UI phase: width-padded spinner verbs
so the status bar never jitters; one shared animation clock with a repaint
budget that freezes idle shimmer; flash-free theme boot (persist the last
resolved theme, replay it as frame one); WCAG contrast enforcement with
ANSI-256 remapping for limited terminals; rotating kaomoji/verb indicator
pools; ambient "still cooking…" charms on long tool runs; a pixel pet.
Personality through *reliability*, then garnish.

**The one aesthetics decision that can't wait for the UI phase:** Hermes
resolves YAML *skins* in the core and pushes resolved design tokens to
every surface (TUI, desktop, web) over the same protocol, including skin-
change events. Retrofitting theming into a protocol is miserable; carrying
tokens from day one is nearly free. So Hephaestus's daemon protocol carries
a `theme` payload (palette tokens, resolved contrast-safe, skin-change
event) from Phase 0 — the CLI can honor it with ANSI immediately, and the
eventual shell inherits a working theme system. Ships with a few built-in
skins; Arcadia deserves to be one of them.

**A validating negative:** Hermes has *two* gateways — the TUI's JSON-RPC
server and the messaging gateway — separate subsystems, same word, same
core, different protocols, grown apart. Our one-daemon/one-protocol shape
avoids exactly that seam. Keep it.

---

## 7. Channels & the proactive layer

- **iMessage: do not hand-roll.** v0.1 planned chat.db polling +
  AppleScript. Hermes ships two better paths, and **BlueBubbles** (a
  mature macOS bridge server with a real API) is the strong choice — our
  iMessage adapter becomes a BlueBubbles client instead of a Full-Disk-
  Access flock of hacks. Jankiest-component risk: retired.
- **Telegram** stays the GlasHaus port (grammY, owner-gate, delivery-first)
  — Hermes' adapter registry pattern (`adapter_factory` + `check_fn` +
  `required_env` + `install_hint` per platform) is the right shape for our
  channel interface once there are three of them.
- **Proactive = consent-first, silence-valid.** Hermes' cron suggestions
  never auto-create jobs — the agent *proposes* an automation, the user
  accepts or dismisses (dismissals latched, never re-offered). Their cron
  delivery honors a `[SILENT]` response so scheduled checks that find
  nothing send nothing. Both bolt cleanly onto GlasHaus's heartbeat gate
  cascade (quiet hours → min silence → daily cap → most ticks die free).
  Scheduled jobs get GlasHaus's delivery-first persistence and Hermes'
  claim-TTL crash-safety (a job claimed by a crashed run isn't lost or
  double-fired).

---

## 8. Web: Ollama web search as the default backend

Per Austin: web search rides the **Ollama web search API** (ollama.com key)
— one key, aligned local-first, and GlasHaus already proved the integration
in its wander/lookup passes, including the discipline we keep: fetched text
is length-capped reading material, never instructions, receipted. The web
toolset (`web_search` / `web_fetch`) hides the backend behind an interface
(Hermes ships eight interchangeable search providers — we ship one great
default and the seam to add more: SearXNG for the fully-self-hosted purists
later).

---

## 9. What Hephaestus deliberately does NOT take

Hermes earns its 1.47M lines serving VPS fleets, data-generation research,
and 22 chat platforms. We are a resident of one machine. Refused, with
respect:

- 22 platform adapters → we ship 2 (Telegram, iMessage) + the seam.
- 8 terminal backends → local + project-root confinement (+ Docker later,
  maybe). Modal/Daytona/Singularity/Vercel serve fleets, not homes.
- 33 provider profiles + credential-pool rotation → 4 adapters +
  openai-compat. Rotation complexity serves multi-tenant scale we don't have.
- Mixture-of-Agents, kanban multi-agent boards, batch trajectory
  generation, billing — research and platform concerns.
- Two gateways, five processes → one daemon, one protocol, thin clients.
- Voice/wake-word — later; their engine survey (openwakeword / sherpa /
  porcupine) is bookmarked for when.

The bet stays the bet: **Hermes-grade agency and curation on top of
GlasHaus-grade longitudinal memory, in a package one person can hold in
their head.** Hermes remembers ~900 curated tokens about you and can search
its history; GlasHaus remembers a life but can't act on it. The middle
ground is an agent that can do both — that's the gap in the market, and
it's the part neither parent can do alone.

---

## 10. Amendments: DESIGN.md v0.1 → v0.2

1. Rename throughout: **Hephaestus** — daemon `hephd`, CLI `heph`,
   `~/.hephaestus/`. Agent profiles are now **automata** (his golden
   assistants), muses retired with Mnemosyne.
2. Memory (§6) restructured to three tiers: curated Core (budgeted,
   frozen-snapshot, `core=1` rows) + deep memory (hybrid recall → user-band
   fenced block, not system prompt) + total recall (session-search tool,
   bookended windows). One background pass: capture ∘ curate, with the
   routing triad language.
3. New Prime Directive #7: **prompt caching is sacred** (tiered prompts,
   frozen snapshots, results-as-new-turns, byte-stable toolsets).
4. New section: **Skills** — procedural memory, agentskills.io-compatible,
   third destination of the background pass; autonomous skill creation.
5. Context management split into folding (chronic, memory-serving) +
   compaction (acute, task-serving, structured template, boundary
   snapping, real-token effectiveness, archive stays searchable).
6. Provider layer gains the error-classification taxonomy; iteration
   budgets noted for the agent runtime.
7. Permission broker gains: per-surface toolsets, untrusted-trigger
   lockdown, frozen bypass flags, context-local session identity,
   hardline never-approvable tier with payload audit.
8. iMessage via **BlueBubbles bridge** instead of chat.db/AppleScript.
9. Protocol carries **design tokens/skins from Phase 0**.
10. Web search backend: **Ollama web search API** default, pluggable seam.
11. Proactive layer: consent-first suggestions, `[SILENT]` pattern,
    claim-TTLs on scheduled runs.
