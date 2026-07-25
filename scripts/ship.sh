#!/usr/bin/env bash
# Ship committed local main: push it to origin, then deploy exactly that
# commit — never the working tree. The working tree is often mid-edit by
# another agent, so the build happens in a throwaway export of HEAD.
#
#   npm run ship            # push + deploy
#   SHIP_DRY_RUN=1 npm run ship   # everything except the push and the deploy
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "ship: on branch '$BRANCH', not main. Refusing." >&2
  exit 1
fi

SHA="$(git rev-parse --short HEAD)"
echo "ship: shipping main @ $SHA"

if [ -n "$(git status --porcelain)" ]; then
  echo "ship: note — working tree has uncommitted changes; they are NOT shipped."
fi

# --- push ---------------------------------------------------------------
if [ "${SHIP_DRY_RUN:-}" = "1" ]; then
  echo "ship: [dry-run] would: git push origin main"
else
  git push origin main
fi

# --- build HEAD in isolation -------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-$HOME/.cache}/skyline-ship-XXXXXX")"
trap 'rm -f "$WORK/node_modules"; rm -rf "$WORK"' EXIT

git archive HEAD | tar -x -C "$WORK"
ln -s "$REPO/node_modules" "$WORK/node_modules"

( cd "$WORK" && npx vite build )

# --- deploy that build --------------------------------------------------
if [ "${SHIP_DRY_RUN:-}" = "1" ]; then
  echo "ship: [dry-run] built $(du -sh "$WORK/dist" | cut -f1) from $SHA; would deploy it"
  exit 0
fi

cd "$WORK"
firebase deploy --only hosting \
  --project skyline-courier-5329 \
  --message "main @ $SHA"

echo "ship: live at https://skyline-courier-5329.web.app ($SHA)"
