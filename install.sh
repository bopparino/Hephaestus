#!/bin/sh
# Hephaestus engine installer — macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/bopparino/Hephaestus/main/install.sh | sh
#
# Tries npm first (@bopparino/hephaestus); falls back to building from
# source into ~/.hephaestus/app with a `heph` shim in ~/.local/bin.
# Windows: use the desktop installer from GitHub Releases, and install the
# engine with `npm install -g @bopparino/hephaestus` in PowerShell.

set -e

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "hephaestus needs $1 — install it and rerun" >&2
    exit 1
  }
}

need node
need npm
major=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$major" -lt 20 ]; then
  echo "node >= 20 required (found $(node -v))" >&2
  exit 1
fi

echo "- trying npm (@bopparino/hephaestus)"
if npm install -g @bopparino/hephaestus >/dev/null 2>&1; then
  echo "+ installed from npm: $(command -v heph || echo 'heph (reopen your shell)')"
else
  echo "  npm package unavailable - building from source"
  need git
  DIR="${HEPHAESTUS_HOME:-$HOME/.hephaestus}/app"
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" pull --ff-only
  else
    mkdir -p "$DIR"
    git clone --depth 1 https://github.com/bopparino/Hephaestus "$DIR"
  fi
  (cd "$DIR" && npm ci && npm run build)
  BIN="$HOME/.local/bin"
  mkdir -p "$BIN"
  printf '#!/bin/sh\nexec node "%s/dist/cli/index.js" "$@"\n' "$DIR" > "$BIN/heph"
  chmod +x "$BIN/heph"
  echo "+ installed from source: $BIN/heph"
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *) echo "  note: add $BIN to your PATH" ;;
  esac
fi

echo
echo "prerequisite: ollama with at least one chat model (https://ollama.com)"
echo
echo "next:  heph start    # wake the daemon"
echo "       heph ui       # open the workshop"
echo "       heph chat     # or stay in the terminal"
