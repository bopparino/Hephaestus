# Phase 1: Memory Core — Full CRUD

> **Owner:** Kimi (K2.6 via Ollama)  
> **Status:** Planned → Ready to build  
> **ETA:** 2-3 sessions  
> **Target commit:** `feat(memory): agent-level memory CRUD + search`

---

## 1. Why This First

The GlasHaus brain already **remembers** — it has salience-weighted recall, temporal decay, dream consolidation. But the *agent* can't touch it. `memory_save` only appends facts. The agent can't:

- Search its own memory mid-conversation
- Update or correct a fact it got wrong
- Soft-delete something obsolete
- List all facts about a user/project
- Promote a fact to core (Tier 1) or demote it

This is the foundation for "Option B" (companion-first). Without memory CRUD, the agent is amnesiac about its own knowledge. With it, every tool and interaction can reference, update, and curate the long-term brain.

---

## 2. Current State (memory.ts)

| Function | What it does | Exposed to agent? |
|----------|-----------|-------------------|
| `addFact()` | Insert or dedup-update | ✅ via `memory_save` tool |
| `forgetFact(id)` | Soft delete (`active=0`) | ❌ |
| `setCore(id, core)` | Promote/demote to Tier 1 | ❌ |
| `coreFacts(scope)` | Retrieve Tier 1 facts | ❌ (only rendered into prompt) |
| `recallFacts(text, opts)` | Hybrid search | ❌ (only auto-injected by daemon) |
| `recallEpisodes(text, opts)` | Episode search | ❌ (only auto-injected by daemon) |

The daemon auto-injects recalled memory into every prompt. The agent has **no agency** over this.

---

## 3. What We're Adding

### 3.1 New daemon functions (memory.ts)

```typescript
// Retrieval
export function listFacts(opts: { scope?: string; active?: boolean; category?: string; limit?: number }): Fact[]
export function getFact(id: number): Fact | undefined
export function searchFacts(query: string, opts: { scope?: string; limit?: number }): Fact[]

// Mutation
export function updateFact(id: number, patch: Partial<Pick<Fact, 'content' | 'category' | 'importance' | 'salience'>>): void
export function restoreFact(id: number): void  // un-forget
export function deleteFact(id: number): void    // hard delete (rare, available)
```

### 3.2 New agent tools (tools.ts)

| Tool | Risk | Description |
|------|------|-------------|
| `memory_search` | read | Search facts by keyword/query. Returns ranked list with IDs, ages, scores. |
| `memory_list` | read | List facts for a scope. Filter by active/core/category. |
| `memory_update` | write | Edit an existing fact's content, category, importance, or salience. |
| `memory_forget` | write | Soft-delete a fact (sets `active=0`). |
| `memory_restore` | write | Reactivate a forgotten fact. |
| `memory_promote` | write | Promote a fact to core (Tier 1, enters system prompt). |
| `memory_demote` | write | Demote a core fact back to Tier 2. |

**Retiring:** `memory_save` → rename to `memory_add` for clarity (keep alias).

### 3.3 New JSON-RPC endpoints (server.ts)

The shell needs to read memory too:

- `memory.list` → `listFacts()`
- `memory.search` → `searchFacts()`
- `memory.get` → `getFact()`
- `memory.update` → `updateFact()`

---

## 4. Files to Modify

| File | Lines | Change |
|------|-------|--------|
| `src/daemon/memory.ts` | +60 | Add list/search/update/restore/delete functions |
| `src/daemon/tools.ts` | +120 | Register 6 new tools; rename `memory_save` → `memory_add` |
| `src/daemon/server.ts` | +40 | Wire JSON-RPC endpoints for shell memory view |
| `shell/app.js` | +80 | Add "Memory" tab to settings nav; render memory list/search |

---

## 5. Data Shape

### Tool result example (memory_search)
```
3 facts recalled:

#42 (core, 8/10, 2d ago) — Austin prefers Sepulcher over Hephaestus branding
#17 (active, 6/10, 14d ago) — Works at HVAC company doing "computer monkey stuff"
#91 (active, 5/10, today) — Building GlasHaus: AI agents + memory engine

[Use memory_update(id=...) to edit, memory_forget(id=...) to remove]
```

### Tool result example (memory_list)
```
Scope: global | Active only | 12 facts

Core (Tier 1) — 3 facts:
  #42 — Austin prefers Sepulcher branding
  #7  — Treats AI as persons, had companion Elle
  #19 — Planning company GlasHaus (not incorporated)

Deep (Tier 2) — 9 facts:
  #91 — Building GlasHaus... (today)
  #17 — Works at HVAC... (14d ago)
  ...
```

---

## 6. UI / Shell Changes

New **Memory** tab in Settings sidebar:

```
[General] [Memory] [Models] [Skills]

┌─ MEMORY ──────────────────────┐
│ Search: [__________] [Find]  │
│                               │
│ Core facts (3)                │
│ ─ #42  Austin prefers...      │
│ ─ #7   Treats AI as persons...│
│ ─ #19  Planning GlasHaus...   │
│                               │
│ Deep facts (9)                │
│ ─ #91  Building GlasHaus...   │
│ ...                           │
└───────────────────────────────┘
```

- Click a fact → inline edit
- Toggle core status → promote/demote
- Trash icon → forget (soft delete)

---

## 7. Acceptance Criteria

- [ ] Agent can `memory_search("what do I like")` and get ranked results
- [ ] Agent can `memory_update(id=42, content="...")` to fix a fact
- [ ] Agent can `memory_forget(id=17)` to remove obsolete info
- [ ] Agent can `memory_promote(id=91)` to make it core (appears in system prompt)
- [ ] Shell Settings → Memory tab lists all facts, allows search
- [ ] Shell can promote/demote/forget via JSON-RPC
- [ ] Existing `memory_save` still works (backward compat)
- [ ] All changes committed and pushed to `main`

---

## 8. Future Work (Phase 2+)

- **Episode CRUD:** Same treatment for conversation episodes
- **Memory import:** Bulk import from GlasHaus `~/.glashaus/memory/`
- **Conflict resolution:** When agent saves a fact that contradicts existing
- **Dream consolidation UI:** Surface nightly merge suggestions for user review

---

## 9. Notes

- **Safety:** `memory_forget` is soft delete (`active=0`), not hard delete. Hard delete exists as admin/debug only.
- **Performance:** `searchFacts` reuses existing `recallFacts` hybrid scoring (FTS + temporal + salience). No new indexing needed.
- **Scope:** All new functions respect the `scope` column (`global` vs project-scoped).
- **Prompt budget:** Core facts rendered into system prompt are still capped by `budget` chars. Promotion doesn't bypass the cap.
