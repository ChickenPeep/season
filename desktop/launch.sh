#!/bin/bash
# Double-clickable launcher: starts the Season app from the repo it lives in.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1
exec ./node_modules/.bin/electron desktop/main.mjs
