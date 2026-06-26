# pi-code
# Command Code provider for pi. Single file. Zero external dependencies.
# 21 models fetched live from the API on startup. Open-source + premium on Pro plan.

## Install
mkdir -p ~/.pi/agent/extensions/pi-code
cp extension.ts ~/.pi/agent/extensions/pi-code/index.ts
# or symlink: ln -s .../pi-modulos/pi-code/extension.ts ~/.pi/agent/extensions/pi-code/index.ts

# API key
export COMMANDCODE_API_KEY=""

# Via pi /login
/login  >  "Use an API key"  >  "Command Code"  >  paste key

# Key stored
~/.pi/agent/auth.json  (key name: sk-pi-code)
