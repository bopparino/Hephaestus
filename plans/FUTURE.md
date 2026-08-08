# Sepulcher Future Features

A living backlog — everything we want to build, organized by phase. Move items up when they're in progress, strike them when they ship.

## Phase 1 Follow-ups (Memory Core polish) ✅ Phase 1 shipped 2026-08-06

- [x] **Full memory CRUD** — search, list, update, forget, restore, promote, demote
- [x] **Memory settings tab** — Shell Settings → Memory with search and listing
- [x] **Dev-mode fallbacks** — localStorage-backed memory for file:// preview

## Phase 2 — Agent Execution ✅ Phase 2 shipped 2026-08-06

- [x] **Clarify** — Ask user mid-task when ambiguous
- [x] **Session Search** — FTS5 keyword search over conversation history
- [x] **Cron/Scheduled Jobs** — cronjob_add, cronjob_list, cronjob_remove tools
- [x] **Code Execution** — Python sandbox with network isolation
- [x] **Browser Automation** — Playwright headless navigation + text extraction

## Phase 3 — Scale ✅ Phase 3 shipped 2026-08-06

- [x] **Parallel Delegation** — delegate tool spawns subagents (already existed, now exposed)
- [x] **TTS / Voice** — text_to_speech via macOS say command
- [x] **iMessage Channel** — send_message via macOS Messages app
- [x] **Skills System** — skills_list, skill_view, skill_save already exist; enhanced by delegate

## Phase 4 — Presence ✅ Phase 4 shipped 2026-08-07 (soul + dream + grow)

- [x] **GlasHaus brain transplant** — self-state, intentions, opinions, quirks schema
- [x] **Persona files** — soul.md, identity.md, user.md, voice.md on disk
- [x] **Soul injection** — persona + self-state rendered into system prompt
- [x] **Dream pass** — nightly salience-weighted replay + realizations + affect rating
- [x] **Grow mode** — weekly self-authorship, revises soul.md from evidence
- [ ] **Heartbeat** — autonomous outreach engine (needs model call)
- [ ] **Desktop Automation** — Drive macOS UI (click, type, screenshot)
- [ ] **Memory Import** — Bulk import from GlasHaus `~/.glashaus/memory/`
- [ ] **Conflict Resolution** — When agent saves a fact that contradicts existing
- [ ] **Dream Consolidation UI** — Surface nightly merge suggestions for user review

## Memory Core UI Polish (Phase 1 follow-ups)

- [ ] **Inline edit** — Click a fact in Settings → Memory to edit content/category/importance
- [ ] **Promote/demote buttons** — ⭐ toggle on each fact row
- [ ] **Forget/restore buttons** — Trash icon → soft delete; restore from "Forgotten" section
- [ ] **Bulk operations** — Multi-select facts, forget/restore/promote many at once
- [ ] **Memory filtering** — Filter by category, importance range, age
- [ ] **Episode CRUD** — Same treatment for conversation episodes (search, edit, forget)

## Quality of Life

- [ ] **Better error handling** — Graceful fallbacks when daemon is unreachable
- [ ] **Dark/light skin polish** — Fix remaining contrast issues on light skins
- [ ] **Settings persistence** — Remember which Settings tab was last open
- [ ] **Keyboard shortcuts** — Cmd+Shift+M for Memory, Cmd+Shift+S for Settings

## Known Issues

- Light skin gradient on `#pane::after` still visible — may need per-skin CSS variable
- Dev mode memory uses localStorage only — no sync with daemon when it comes online
- PP Mondwest font requires manual install (personal-use license)

## Ideas (unscoped)

- Voice input (Whisper) for the composer
- Image generation via MCP (ComfyUI, etc.)
- Telegram bot commands for memory search/forget
- Export memory to Obsidian vault
- AI-suggested memory consolidation ("these 3 facts could be merged into 1")
- Memory decay visualization (heatmap of fact ages)
- Scheduled memory review ("facts older than 90 days you might want to update")
