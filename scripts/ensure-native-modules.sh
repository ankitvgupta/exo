#!/bin/bash
# Ensure native modules (better-sqlite3) are compiled for Electron's ABI.
# Runs quickly (~200ms) if already correct; rebuilds only when needed.

NATIVE_MODULE="node_modules/better-sqlite3/build/Release/better_sqlite3.node"

if [ ! -f "$NATIVE_MODULE" ]; then
  echo "Native module not found, rebuilding..."
  exec npx electron-rebuild -f -w better-sqlite3
fi

# Check if the .node binary was compiled for system Node (wrong) or Electron (right).
# We need to instantiate a Database to trigger the actual native module load —
# require('better-sqlite3') alone doesn't load the .node binding.
if node -e "new (require('better-sqlite3'))(':memory:')" 2>/dev/null; then
  echo "Native module compiled for system Node, rebuilding for Electron..."
  exec npx electron-rebuild -f -w better-sqlite3
else
  echo "Native modules OK"
fi
