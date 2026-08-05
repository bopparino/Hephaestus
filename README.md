# ΗΦΑΙΣΤΟΣ · Hephaestus

**A local-first AI workspace with a real memory.** Chat, a development
agent, system governance, and projects — running as one daemon on your
machine, remembering across all of it. Frontier models as guests, local
models as residents, your memory in one SQLite file you own.

> Hermes remembers ~900 curated tokens about you. GlasHaus remembers a
> life but can't act on it. Hephaestus is the forge between: an agent with
> hands, grounded in deep memory.

One Liner Install: curl -fsSL https://raw.githubusercontent.com/bopparino/Hephaestus/main/install.sh | sh

**Status: pre-alpha.**

## The documents

- [DESIGN.md](DESIGN.md) — the architecture: daemon + thin clients,
  three-tier memory, automata, MCP tool bus, prime directives.
- [FORGE_NOTES.md](FORGE_NOTES.md) — the comparative study (Hermes Agent
  vs. GlasHaus) every design decision traces back to.
- [AESTHETIC.md](AESTHETIC.md) — the design language: typography, layout
  doctrine, and the sixteen skins in [`skins/`](skins/).

## Lineage

Born from [GlasHaus](https://github.com/bopparino)'s memory engine;
raised on lessons from [Hermes Agent](https://github.com/nousresearch/hermes-agent).
Named for the god who built automatons to help him in his own workshop.

## Theming & Typography

Hephaestus ships with **Sepulcher** — a grimdark UI theme (deep indigo
void, parchment ink, no boxes, floating text) — plus **15 additional
skins** (8 dark + 8 light) selectable in Settings or via the shell's
skin dropdown.

### Hero Font Library

The landing "Sepulcher" text uses a user-selectable hero font. Five
faces are available in Settings → General:

| Font | Source | License |
|------|--------|---------|
| **PP Mondwest** | Manual install | Personal-use |
| **Cinzel** | Google Fonts | OFL |
| **MedievalSharp** | Google Fonts | OFL |
| **Pirata One** | Google Fonts | OFL |
| **UnifrakturMaguntia** | Google Fonts | OFL |

### Installing PP Mondwest (optional)

PP Mondwest is the default display face but is **not redistributed**
with this repo (personal-use license). To use it:

**For dev preview** (standalone HTML):
```bash
cp /path/to/ppmondwest-regular.otf shell/userfonts/
cp /path/to/ppneuebit-bold.otf shell/userfonts/
open shell/index.html
```

**For the full app** (daemon mode):
```bash
mkdir -p ~/.hephaestus/fonts
cp /path/to/ppmondwest-regular.otf ~/.hephaestus/fonts/
cp /path/to/ppneuebit-bold.otf ~/.hephaestus/fonts/
```

The other four fonts load automatically from Google Fonts — no setup
needed. If PP Mondwest is missing, the hero text falls back to
Georgia/system serif.

### Dev Mode Skin Switching

The web shell can be opened directly without the daemon:
```bash
open shell/index.html
```

In this mode all 16 skin palettes are embedded, and the skin selector
at the bottom of the sidebar works instantly. Changes persist via
`localStorage`.

## Fonts

Ships with Departure Mono (OFL) and JetBrains Mono (Apache-2.0). The
display face prefers **PP Mondwest** when present — a personal-use font
you install yourself to `~/.hephaestus/fonts/`; it is never distributed
with this repository. See AESTHETIC.md §1.

## License

MIT — see [LICENSE](LICENSE).
