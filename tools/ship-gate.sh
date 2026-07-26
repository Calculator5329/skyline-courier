#!/usr/bin/env bash
# Is the tree at a shippable point right now?
#
# Agents edit continuously, so "it built" is not enough — a green build with a
# black screen shipped once already and the harness is the only thing that
# caught it. This runs the same checks every time so deploy decisions are not
# made by eye.
#
# Exit 0 = shippable. Exit 1 = not (reason printed).
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

fail() { echo "GATE: NO — $1"; exit 1; }

# 1. Build must be green.
if ! npm run build >/tmp/skyline-gate-build.log 2>&1; then
  fail "build is red (agent mid-edit)"
fi

# 1b. Build what is actually STAGED, not what happens to be on disk.
#
# Agents edit continuously, so a file can change in the seconds between the
# gate passing and the commit landing — which is exactly how a half-written
# level.js got committed and pushed once. Building the staged tree in isolation
# closes that window: whatever we are about to commit is what we just proved.
# Only meaningful when something is staged; a bare gate run skips it.
if ! git diff --cached --quiet 2>/dev/null; then
  STAGE=$(mktemp -d "${TMPDIR:-$HOME/.cache}/skyline-stage-XXXX")
  git archive "$(git write-tree)" | tar -x -C "$STAGE"
  ln -sfn "$REPO/node_modules" "$STAGE/node_modules"
  if ! ( cd "$STAGE" && npx vite build >/tmp/skyline-gate-staged.log 2>&1 ); then
    fail "the STAGED tree does not build (a file changed after the disk build) — see /tmp/skyline-gate-staged.log"
  fi
  echo "gate: staged tree builds clean"
fi

# 2. Shots must render real geometry. The harness flags uniform frames itself.
OUT=$(mktemp -d "${TMPDIR:-$HOME/.cache}/skyline-gate-XXXX")
SHOTS=$(timeout 260 node tools/shotset.mjs --no-build --port 5181 --out "$OUT" 2>&1)
echo "$SHOTS" | tail -12

echo "$SHOTS" | grep -q "uniform-frame" && fail "one or more shots render a blank frame"

# 3. Luminance sanity: the all-black regression measured ~6. Anything under 30
#    across the set means the exposure or lighting has fallen over.
LOWLUM=$(echo "$SHOTS" | awk '/^(terrace|gaps|crossing|underpass|chain|tower|vista|closeup)/ {
  for (i=1;i<=NF;i++) if ($i ~ /^[0-9]+\.?[0-9]*$/ && $i+0 > 0) { if ($i+0 < 30) print $1; break }
}' | head -3)
[ -n "$LOWLUM" ] && fail "shots too dark (likely exposure regression): $LOWLUM"

echo "GATE: OK — build green, all shots render, luminance sane"
exit 0
