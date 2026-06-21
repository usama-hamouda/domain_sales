#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/backend"
echo "Starting Domain Sales on http://127.0.0.1:${PORT:-3001}"
exec node server.js
