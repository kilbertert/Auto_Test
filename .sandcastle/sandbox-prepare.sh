#!/usr/bin/env bash
#
# Prepare an Auto-Test sandbox for an AFK run.
#
# A run's workspace starts empty — `node_modules/` is gitignored, so every check
# this project runs (`npm run check` → typecheck + vitest + build) fails until it
# is installed. Idempotent — sandcastle runs this once per iteration.
set -euo pipefail

npm ci

