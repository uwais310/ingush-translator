#!/bin/sh
# macOS / Linux: sh start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; exit 1; fi
if [ ! -f .env ]; then cp .env.example .env; echo "Created .env. Open it, paste your Gemini key after GEMINI_API_KEY= and run this file again."; exit 0; fi
exec node server.js
