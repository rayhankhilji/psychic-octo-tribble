#!/bin/bash
# Cloud sessions: install dependencies so `npm test`, `npm run typecheck`,
# `npm run dev` and the screenshot tools in tools/ work straight away.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
# Never download browsers: cloud containers ship Chromium for Playwright.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install --no-audit --no-fund
