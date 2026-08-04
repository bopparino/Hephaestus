# AESTHETIC — the Hephaestus design language
### Companion to DESIGN.md §12 · locked August 2026

The brief, verbatim: *Hermes Agent meets Grok UI, easy to use but slightly
grimdark.* Decomposed:

- **From Hermes:** the *structure* of polish — skins as first-class tokens
  pushed from the daemon, layout stability as a fetish, ambient personality
  in small doses, a distinctive display face doing brand work while a
  humanist sans does the reading.
- **From Grok:** restraint. Near-monochrome surfaces, one accent doing all
  the talking, generous negative space, no gradients-for-gradients' sake,
  chrome that disappears while you work.
- **Grimdark:** the *temperature*. Iron, ember, bone, bronze, parchment —
  never neon, never candy. Light modes are marble and manuscript, not
  bubblegum. Microcopy has weight ("forging…", not "hang tight! ✨").
  Sleep Token, not Saturday-morning cartoon. Easy to use means the darkness
  is tonal, never obstructive: contrast stays WCAG-enforced, hierarchy
  stays obvious, nothing sacrifices legibility for mood.

---

## 1. Typography

Three roles, locked:

| role | face | license / distribution |
|---|---|---|
| **Display** (banners, section headers, brand chrome — used sparingly, Hermes-style) | **PP Mondwest**, falling back to **Departure Mono** | Mondwest: personal-use license, user-installed to `~/.hephaestus/fonts/`, **never committed to this repo**. Departure Mono: SIL OFL, ships in-repo, covers Greek glyphs (the banner gets to say ΗΦΑΙΣΤΟΣ). |
| **Body** (everything you read) | **Inter** default; curated catalog: IBM Plex Sans, Work Sans, DM Sans, Atkinson Hyperlegible, Spectral, Fraunces, Source Serif 4 | All Google Fonts / OFL — redistributable. Catalog is an *override layer* independent of skin (Hermes' pattern: pick a font once, it survives theme switches; vetted list only, never a free-URL box — that's a self-XSS footgun). |
| **Mono** (code, transcripts, receipts) | **JetBrains Mono**; catalog: IBM Plex Mono, Space Mono, system | Apache-2.0, ships in-repo. |

CSS stacks (the shipped truth):

```css
--font-display: "PP Mondwest", "Mondwest", "Departure Mono", monospace;
--font-sans: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono: "JetBrains Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
```

Display face rules (this is what keeps pixel-serif from becoming a costume):
headers and brand moments only, roughly Hermes' uppercase-chrome pattern;
body text is never pixelated; the TUI gets the display face only in the
banner (terminals own their fonts — the CLI's aesthetic lives in palette,
spacing, and the banner art).

## 2. Layout & motion doctrine

Inherited from the Hermes study (FORGE_NOTES §6), enforced from the first
client:

1. **Nothing jitters.** Variable-width status content is width-padded to
   its widest state (their rotating-verb trick). Layout shift is a bug.
2. **One clock.** All ambient animation shares a single timer with a
   repaint budget; idle surfaces stop painting entirely.
3. **No flash of wrong theme.** Last resolved theme persists and replays
   as frame one on boot.
4. **Contrast is computed, not assumed.** The daemon resolves every skin
   through a contrast pass (WCAG AA minimum against its own canvas) before
   any client paints it. A skin that authors a background owns polarity.
5. **Density calm, information dense.** Grok restraint on chrome; the data
   (transcripts, receipts, memory) is allowed to be dense.
6. **Personality is a garnish.** Rotating forge-verbs on spinners, a charm
   line when a tool runs long ("still in the coals…"), `/fortune`-class
   easter eggs — all optional, all off in `--plain` mode, none load-bearing.

**The forge lexicon** (spinner verbs, shipped default set): *stoking,
hammering, quenching, casting, tempering, annealing, drawing, riveting,
smelting, polishing, forging, bellowing*. Long-run charms: "still in the
coals…", "the bellows are steady…", "good steel takes time…". Grimdark
restraint rule: serious operations (destructive proposals, security
prompts, failures) get plain language, zero whimsy — the forge jokes only
while the work is safe.

## 3. Skins — 8 dark, 8 light

Skins are YAML token files in `skins/` (see §4 for the schema), resolved
by the daemon and pushed to every client over the protocol (DESIGN.md
§12). Accent discipline: `accent` is the voice, `accentAlt` the
counterpoint — a surface uses one at a time.

### Dark

| skin | canvas | voice | the idea |
|---|---|---|---|
| **forge** *(default dark)* | warm iron-black `#16130F` / bone `#E8DFD0` | ember `#E86F2D` + spark gold `#D9A441` | the signature: banked coals in a dark smithy |
| **arcadia** | charcoal `#2B2C30` / parchment `#D3C9AE` | antique gold `#C2A34E` + crimson `#B12C50` | Austin's "Even in Arcadia" rice, ported faithfully (mauve `#8A5769` as selection, slate `#888C91` as muted) |
| **obsidian** | true black `#0A0A0B` / `#E6E4E1` | molten gold `#D4AF37`, otherwise monochrome | the Grok-est: volcanic glass, one gold vein |
| **lemnos** | ash-brown `#191416` / `#E3D9D3` | lava `#D14A3C` + burnt clay `#C97F5E` | the volcanic island he fell to |
| **aegean-night** | abyssal teal `#061A1C` / `#DCE8E4` | bronze `#C08B4C` + sea-teal `#4FB3A5` | a respectful nod to Hermes' teal, taken deeper |
| **talos** | dark umber `#141210` / aged brass `#E5D9C3` | polished bronze `#B08D57` + verdigris `#6FA287` | the bronze automaton |
| **nether** | violet-black `#131017` / `#DED7E6` | dusk violet `#A88FCC` + tarnished silver `#C0BFC7` | the grimdark-est shelf |
| **oxide** | gunmetal `#101619` / `#D5DEDE` | verdigris `#57A38B` + steel `#8FA3AD` | copper patina on cold iron |

### Light

| skin | canvas | voice | the idea |
|---|---|---|---|
| **daybreak** *(default light)* | warm paper `#F3EDE2` / iron `#2A241C` | ember `#C25A1F` + old gold `#9A7B2E` | the forge at dawn, fire low |
| **arcadia-day** | pale parchment `#F1ECDF` / charcoal `#2B2C30` | deep gold `#A08334` + crimson `#B12C50` | the rice, inverted for daylight |
| **marble** | Parian white `#F5F4F1` / graphite `#26262B` | oxblood `#7A2E2E` + slate `#5B5B66` | statuary; grimdark light done right |
| **parchment** | aged cream `#F0E7D3` / sepia ink `#3B2F1F` | umber `#8C5A22` + rubric red `#A03A2E` | an illuminated manuscript (rubrication as the interactive accent) |
| **aegean-day** | sea glass `#EDF3F1` / `#1C2F2E` | deep teal `#1F7A6E` + bronze `#B0803F` | the same sea, sun up |
| **gypsum** | gallery white `#FAFAF8` / near-black `#1B1B1E` | dark gold `#B8860B`, otherwise monochrome | obsidian's daylight twin |
| **olive** | sage `#F0F1E6` / `#26291C` | olive `#6B7A3A` + amber `#A66A2E` | the grove outside the workshop |
| **terracotta** | clay `#EFE0D0` / slip-black `#241A12` | pot red `#B5522A` + slip brown `#33281E` | black-figure amphora |

`forge`/`daybreak` are the shipped defaults and track OS dark/light unless
pinned. Every skin passes the daemon's contrast resolver; the tables above
are intent, the YAML in `skins/` is truth.

## 4. Skin schema

```yaml
# skins/forge.yaml — one file per skin, ~/.hephaestus/skins/ overlays these
name: forge            # stable id
label: Forge           # display name
polarity: dark         # dark | light — the OS-tracking pair-picker key
palette:
  bg: "#16130F"        # app canvas
  bgAlt: "#1E1A14"     # sidebars, wells
  surface: "#262019"   # cards, inputs, hovers
  border: "#3A3126"
  fg: "#E8DFD0"        # primary text
  fgMuted: "#8F8574"   # secondary text, timestamps
  accent: "#E86F2D"    # THE color: brand, links, active states
  accentAlt: "#D9A441" # counterpoint: selections, secondary interactive
  positive: "#7A9A5E"  # semantic four — muted, grimdark-tuned
  warning: "#D9A441"
  danger: "#C24434"
  info: "#7FA8A0"
verbs: [stoking, hammering, quenching]   # optional spinner-verb override
```

Resolution order: built-in `skins/` → user `~/.hephaestus/skins/` (same
name overrides, Hermes-style). The daemon derives what clients need
(hover/active mixes, ANSI-16 approximations for the CLI, contrast-lifted
text variants) so skin authors write 12 colors, not 60. Skin changes
broadcast as a protocol event; clients repaint live.

## 5. What we do not do

No neon, no glassmorphism, no gradient washes, no emoji confetti, no
rounded-everything. No light theme that reads as a different product from
its dark sibling. No theme-able *layout* — skins recolor, they never
rearrange. And nothing in this file justifies breaking §2's doctrine:
when mood and usability fight, usability wins and the mood finds another
way in.

**No AI-SaaS tells** (locked 2026-08-04, per Austin, Grok as reference):
no pill badges, no fingernail accent chips, no bordered tag confetti on
every row — metadata is plain muted text. Flat over boxed: hairline
separators and background tints carry structure; borders are earned, not
default. No emojis anywhere in UI chrome — geometric glyphs (›, ·) or
words. Hierarchy comes from type (size, weight, spacing, the display
face used sparingly), not from decoration. When in doubt: remove the
border, remove the badge, add whitespace.
