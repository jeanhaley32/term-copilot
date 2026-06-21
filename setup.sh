#!/usr/bin/env bash
#
# term-copilot installer. Idempotent — safe to re-run.
#
#   ./setup.sh
#
# Installs deps, links the Hyper plugin, enables it in ~/.hyper.js, and checks
# that Claude Code is logged in. Does not push or change your git config.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_LINK="$HOME/.hyper_plugins/local/hyper-term-copilot"
HYPER_CFG="$HOME/.hyper.js"
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
step() { printf "\n\033[1m%s\033[0m\n" "$1"; }

step "1. Checking prerequisites"
command -v node >/dev/null || { echo "Node.js is required: https://nodejs.org"; exit 1; }
ok "node $(node --version)"

if command -v claude >/dev/null; then
  ok "claude $(claude --version 2>/dev/null | head -n1)"
else
  warn "claude (Claude Code) not found — install it and run 'claude' to log in."
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  warn "ANTHROPIC_API_KEY is set — unset it to use your subscription instead of the API."
else
  ok "ANTHROPIC_API_KEY not set (subscription auth)"
fi

step "2. Installing dependencies"
( cd "$DIR" && npm install --silent )
ok "npm install"

step "3. Installing Hyper"
if [ -d "/Applications/Hyper.app" ]; then
  ok "Hyper present"
elif command -v brew >/dev/null; then
  warn "Hyper not found — installing via Homebrew…"
  brew install --cask hyper
  ok "Hyper installed"
else
  warn "Hyper not found and Homebrew unavailable. Install from https://hyper.is then re-run."
fi

step "4. Linking the plugin"
mkdir -p "$HOME/.hyper_plugins/local"
ln -sfn "$DIR/hyper-plugin" "$PLUGIN_LINK"
ok "linked $PLUGIN_LINK"

step "5. Enabling the plugin in ~/.hyper.js"
# Launch Hyper once to generate the config if it doesn't exist yet.
if [ ! -f "$HYPER_CFG" ] && [ -d "/Applications/Hyper.app" ]; then
  warn "No ~/.hyper.js yet — launching Hyper once to generate it…"
  open -a Hyper; for _ in $(seq 1 10); do [ -f "$HYPER_CFG" ] && break; sleep 1; done
fi
if [ -f "$HYPER_CFG" ]; then
  node -e '
    const fs=require("fs"), p=process.env.HOME+"/.hyper.js";
    let s=fs.readFileSync(p,"utf8");
    if(s.includes("hyper-term-copilot")){ console.log("already enabled"); process.exit(0); }
    const re=/localPlugins:\s*\[([^\]]*)\]/;
    if(!re.test(s)){ console.error("could not find localPlugins in ~/.hyper.js — add manually: localPlugins: [\"hyper-term-copilot\"]"); process.exit(3); }
    s=s.replace(re,(m,inner)=>{const t=inner.trim().replace(/,\s*$/,""); return "localPlugins: ["+(t?t+", ":"")+"\"hyper-term-copilot\"]";});
    fs.writeFileSync(p,s); console.log("enabled");
  ' && ok "enabled in ~/.hyper.js (restart Hyper to load)"
else
  warn "~/.hyper.js not found. Launch Hyper once, then add: localPlugins: [\"hyper-term-copilot\"]"
fi

step "Done"
cat <<EOF
  Start it with:
      cd "$DIR" && ./start.sh
  (or: npm run bridge  in one terminal, then open Hyper)

  Make sure Claude Code is logged in:  claude  →  /login
EOF
