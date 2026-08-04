# GAPS — what Hermes can do that Hephaestus can't (yet)

*The ledger, 2026-08-04. Companion and memory excluded by agreement — memory
is our thesis, not our gap. Sourced from the three-agent study of
nousresearch/hermes-agent (~1.47M lines Python) vs. our working tree.
Every entry gets a verdict: BUILD NEXT, RIDE-ALONG, LATER, ALREADY OURS
(different shape), or REFUSED (on-thesis).*

Current Hephaestus hands, for honesty's sake: `fs_read, fs_write, fs_list,
fs_grep, shell, memory_save, skills_list, skill_view, skill_save`. Channels:
shell, CLI, Telegram. No scheduler, no web tools, no MCP, no delegation,
no voice.

---

## BUILD NEXT — the four that close real distance

**1. The heartbeat: scheduler + proactive delivery.**
Hermes: cron expressions + human intervals + one-shots (croniter), script
pre-gates that decide whether to wake the model at all, `[SILENT]` so a
quiet check sends nothing, delivery routing to any channel, consent-first
suggestions (never auto-created). A workspace that cannot wake itself is a
tool, not a resident — this is the single highest-value gap. Ours: jobs
table + daemon ticker + delivery-first to Telegram/shell + `[SILENT]` +
receipts for every firing. Their DST/timezone-shift handling and one-shot
run-claim TTL (crash ≠ lost job, ≠ double-fire) are lessons to keep.

**2. Web hands: `web_search` + `web_fetch`.**
Hermes ships 8 pluggable search backends. We need exactly one: the Ollama
web search API — already proven in GlasHaus (wander/lookup), already
decided. Both automata get it; results ride in fenced as untrusted
reference, same as referenced sessions. Small build, big reach.

**3. MCP client — the ecosystem door.**
Hermes' largest tool file (7.2k lines) for good reason: one integration
buys every MCP server anyone ships. Ours starts narrow: stdio transport
only, each server a config entry, each server's tools a toolset with
broker risk `ask` by default, tool descriptions scanned before they enter
a prompt (their `_scan_mcp_description` lesson). No OAuth, no HTTP
transport, no sampling handler in v1.

**4. Delegation — one lane, budgeted.**
Hermes: `delegate_task` with parallel batches, iteration budgets, async
completion queues. Ours: a single background dev run per session, with an
iteration budget, whose completion arrives as a *new turn* — their
role-alternation lesson (never splice results mid-transcript; it breaks
prompt caching and message alternation). No fleets. No kanban.

## RIDE-ALONG — hardening that ships with the above

- **Hardline list**: commands that are never approvable regardless of
  grants (`rm -rf /`, fork bombs, `curl | sh`, `dd` to devices,
  `chmod -R 777 /`). Hermes keeps these separate from the approvable tier;
  so will the broker.
- **Injection fences everywhere untrusted text enters**: Telegram messages,
  web results, MCP tool results and descriptions. We already fence
  referenced sessions ("reference material, not instructions") — make it
  a single helper and apply it uniformly.
- **Approval state stays server-side and frozen** — Hermes learned this
  twice (env-var YOLO race, GHSA-96vc-wcxf-jjff). Our broker already lives
  in the daemon; write the invariant down so it survives us.

## LATER — worth wanting, not worth now

- **Voice**: local STT (whisper.cpp) + TTS (macOS `say` first, Piper
  after), push-to-talk in the shell; wake word only if the itch is real.
  Their barge-in and hallucination-filter details are documented for when
  we get there.
- **execute_code**: programmatic tool calling where only stdout enters
  context — the token-economy play for big operations.
- **Editor protocol (ACP)**: let Zed drive the dev automaton; the Workshop
  editor pane is nearer-term.
- **Image generation**: local ComfyUI/mflux bridge when the workshop wants
  pictures. Video generation: no.
- **`heph export` / `heph doctor`**: the moving ritual (sessions + memory
  + config tarball) and the health check. Small, honest utilities.
- **Browser automation**: only if a real need shows; `web_fetch` covers
  reading.

## ALREADY OURS — same need, different shape

- **Receipts** are our observability; no Langfuse plugin needed.
- **Skins** ≈ their skin SDK, but ours rides one protocol to every glass
  (they grew two gateway stacks; we refused that seam on day one).
- **Session search** — their bookended-window design, already adopted.
- **Compaction** — their structured-summary design, already adopted,
  smaller.
- **Memory** — theirs is two flat files + FTS5; ours is the transplanted
  GlasHaus engine with scopes, salience, folding, and the capture∘curate
  pass. This is the moat, not the gap.
- **Projects** — they gate `project_*` tools to the GUI; ours are
  first-class across CLI, shell, memory, and the agent.
- **Approvals** — their `approval.py` is 4,351 lines; ours is ~200 and
  server-side. Scale when reality demands, not before.

## REFUSED — on-thesis, permanently or until the thesis changes

- **20+ chat platforms.** Home-shaped, not server-shaped. Telegram, shell,
  CLI — plus iMessage as the one open question (chat.db is right there on
  this Mac; BlueBubbles or read-only + Shortcuts send. Undecided, not
  refused).
- **Kanban / multi-agent fleets.** One resident, many hands — not a farm.
- **Credential pools, billing rails, provider failover ladders.** Two
  providers, four lanes; a fallback binding per lane is plenty.
- **Skills hub / marketplace.** Local skills only; import-with-scan maybe,
  someday. The supply chain stays short enough to see.
- **Cloud sandboxes** (Docker/Modal/Daytona/Vercel). Our isolation is the
  permission spine + project-root confinement; the day we need more, it's
  a worktree, not a datacenter.
- **Surface sprawl** (Termux, Nix flakes, PWA, batch datagen). The forge
  serves one street.

---

## The order

1. Heartbeat (scheduler + delivery + `[SILENT]`)
2. Web hands (Ollama search/fetch)
3. MCP client (stdio, broker-gated, scanned)
4. Hardline list + uniform injection fences (rides with 1–3)
5. Delegation (one lane, budgeted)

Then voice, as the treat. Everything else earns its place by being missed
in daily use, not by being on this list.
