#!/bin/sh
# Start the MCP server from the repository root, so src/config.ts finds .env.
# A global MCP install runs from the caller's project directory otherwise.
cd "$(dirname "$0")/.." || exit 1
exec node dist/server.js
