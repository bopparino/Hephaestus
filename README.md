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

## Fonts

Ships with Departure Mono (OFL) and JetBrains Mono (Apache-2.0). The
display face prefers **PP Mondwest** when present — a personal-use font
you install yourself to `~/.hephaestus/fonts/`; it is never distributed
with this repository. See AESTHETIC.md §1.

## License

MIT — see [LICENSE](LICENSE).
