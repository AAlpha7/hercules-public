#!/usr/bin/env bash
# deploy-production.sh <sha> — pin production checkout to a verified release sha.
#
# Design §4 production path. Generalizes Settings self-update (src/server/selfUpdate.ts)
# for a *pinned* sha instead of pull --ff-only:
#   git fetch → checkout/reset <sha> → pnpm install --frozen-lockfile → pnpm build → restart
#
# Invoked by promoteService (WORKFLOW deploy.production.command) with scrubbed env —
# do NOT rely on HERCULES_* vars. Override:
#   PROD_CODE (default /home/ubuntu/hercules-release — DEDICATED release clone.
#     Never the operator working tree: a promote raced concurrent operator
#     builds/tests there and both deploy and rollback failed, 2026-07-18.)
#   PROD_UNIT (default hercules)
#
# Restart: passwordless sudo systemctl (same as selfUpdate), else NEEDS-OPERATOR exit 0.
set -euo pipefail

PROD_CODE="${PROD_CODE:-/home/ubuntu/hercules-release}"
PROD_UNIT="${PROD_UNIT:-hercules}"

log() { printf '[deploy-production] %s\n' "$*"; }
die() { printf '[deploy-production] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  printf 'Usage: %s <sha>\n' "$(basename "$0")" >&2
  printf '  Pin production checkout to the given git sha, install, build, restart.\n' >&2
  exit 1
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage
[[ $# -ge 1 ]] || usage

SHA="$1"
# Full or abbreviated hex sha only — refuse path traversal / ref injection.
if ! [[ "${SHA}" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  die "invalid sha '${SHA}' (expected 7–40 hex chars)"
fi

[[ -d "${PROD_CODE}" ]] || die "production code dir missing: ${PROD_CODE}"
[[ -d "${PROD_CODE}/.git" || -f "${PROD_CODE}/.git" ]] || die "not a git checkout: ${PROD_CODE}"

cd "${PROD_CODE}"

log "fetching origin (cwd=${PROD_CODE})"
git fetch --no-tags origin

# Ensure the sha is present (fetch may need the object from origin).
if ! git cat-file -e "${SHA}^{commit}" 2>/dev/null; then
  # Try fetching the sha explicitly (some remotes allow it).
  git fetch --no-tags origin "${SHA}" 2>/dev/null || true
fi
git cat-file -e "${SHA}^{commit}" 2>/dev/null || die "sha ${SHA} not found after fetch"

log "checkout + reset --hard ${SHA}"
# Pin the tree to the release sha. When that sha IS the current origin/main
# tip (the normal promote), stay ON the main branch so the clone tracks main
# cleanly. Only a genuinely older pin (rollback / re-promote of a past sha)
# detaches. (This is a DEDICATED release clone since 2026-07-23 — the
# operator working repo is never touched by deploys.)
if [[ "$(git rev-parse "origin/main^{commit}" 2>/dev/null || true)" == "$(git rev-parse "${SHA}^{commit}")" ]]; then
  git checkout --force -B main "${SHA}"
else
  git checkout --force --detach "${SHA}"
fi
git reset --hard "${SHA}"

log "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

log "pnpm build"
pnpm build

# Restart — align with selfUpdate defaultRestarter (sudo -n systemctl restart).
unit="${PROD_UNIT%.service}"
if systemctl --user cat "${unit}.service" >/dev/null 2>&1; then
  log "restarting user unit ${unit}"
  systemctl --user restart "${unit}.service"
  log "production deploy complete sha=${SHA:0:12}"
  exit 0
fi

if systemctl cat "${unit}.service" >/dev/null 2>&1; then
  if sudo -n systemctl restart "${unit}.service" 2>/dev/null; then
    log "restarted system unit ${unit} via sudo -n"
    log "production deploy complete sha=${SHA:0:12}"
    exit 0
  fi
  printf 'NEEDS-OPERATOR: sudo systemctl restart %s.service\n' "${unit}"
  log "build ready at ${SHA:0:12}; operator must run the restart command above"
  exit 0
fi

printf 'NEEDS-OPERATOR: sudo systemctl restart %s.service\n' "${unit}"
log "unit '${unit}' not found; code is at ${SHA:0:12} — see docs/deploy.md"
exit 0
