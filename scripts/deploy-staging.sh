#!/usr/bin/env bash
# deploy-staging.sh — build current main into the persistent hercules-staging tree.
#
# Design §4 / docs/deploy.md. Invoked by the release reconciler (WORKFLOW
# deploy.staging.command) with scrubbed env — do NOT rely on HERCULES_* vars.
#
# Steps:
#   1. Resolve main tip (bare mirror cwd or working-tree origin/main)
#   2. Sync STAGING_CODE to that sha, pnpm install --frozen-lockfile + build
#   3. Refresh STAGING_CONTROL copy from live control repo (realistic data,
#      isolated mutations), then reset the staging M4 shadow store so it
#      re-projects from the refreshed copy (envelopes bind to git history)
#   4. Restart hercules-staging (user unit preferred; else sudo -n; else
#      NEEDS-OPERATOR exit 0 for the shepherd)
#
# Override paths via non-HERCULES_ env knobs (survive scrubHerculesEnv):
#   STAGING_CODE, STAGING_CONTROL, STAGING_CONTROL_SRC, STAGING_UNIT,
#   STAGING_ENV_FILE, STAGING_WORK_DIR (informational), DEFAULT_BRANCH, PROD_CODE
set -euo pipefail

STAGING_CODE="${STAGING_CODE:-/home/ubuntu/projects/Hercules-staging}"
STAGING_CONTROL="${STAGING_CONTROL:-/home/ubuntu/hercules-live-staging}"
STAGING_CONTROL_SRC="${STAGING_CONTROL_SRC:-/home/ubuntu/hercules-live}"
STAGING_UNIT="${STAGING_UNIT:-hercules-staging}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
PROD_CODE="${PROD_CODE:-/home/ubuntu/projects/Hercules}"

log() { printf '[deploy-staging] %s\n' "$*"; }
die() { printf '[deploy-staging] ERROR: %s\n' "$*" >&2; exit 1; }

# ── resolve source sha of main ──────────────────────────────────────────────
resolve_main_sha() {
  if git rev-parse --is-bare-repository 2>/dev/null | grep -qx true; then
    if git rev-parse --verify "refs/heads/${DEFAULT_BRANCH}" >/dev/null 2>&1; then
      git rev-parse "refs/heads/${DEFAULT_BRANCH}"
      return
    fi
    die "bare mirror has no refs/heads/${DEFAULT_BRANCH}"
  fi
  # Working tree: prefer origin/main (post-fetch), fall back to local main.
  if git rev-parse --verify "refs/remotes/origin/${DEFAULT_BRANCH}" >/dev/null 2>&1; then
    git rev-parse "refs/remotes/origin/${DEFAULT_BRANCH}"
    return
  fi
  if git rev-parse --verify "refs/heads/${DEFAULT_BRANCH}" >/dev/null 2>&1; then
    git rev-parse "refs/heads/${DEFAULT_BRANCH}"
    return
  fi
  die "cannot resolve ${DEFAULT_BRANCH} tip"
}

resolve_origin_url() {
  if git remote get-url origin >/dev/null 2>&1; then
    git remote get-url origin
    return
  fi
  if [[ -d "${PROD_CODE}/.git" ]] && git -C "${PROD_CODE}" remote get-url origin >/dev/null 2>&1; then
    git -C "${PROD_CODE}" remote get-url origin
    return
  fi
  die "cannot resolve origin URL for staging clone"
}

is_bare() {
  git rev-parse --is-bare-repository 2>/dev/null | grep -qx true
}

# ── sync staging code tree to sha ───────────────────────────────────────────
sync_staging_code() {
  local sha="$1"
  local url="$2"
  mkdir -p "$(dirname "${STAGING_CODE}")"

  if [[ ! -d "${STAGING_CODE}/.git" ]]; then
    log "cloning origin into ${STAGING_CODE}"
    if is_bare; then
      # Clone from this bare mirror (file://) so we do not need network.
      git clone --no-checkout "file://$(pwd)" "${STAGING_CODE}"
      git -C "${STAGING_CODE}" remote set-url origin "${url}"
    else
      git clone --no-checkout "${url}" "${STAGING_CODE}"
    fi
  fi

  log "fetching + checking out ${sha:0:12} in staging code tree"
  if is_bare; then
    # Refresh objects from the bare mirror used as deploy cwd.
    git -C "${STAGING_CODE}" fetch --no-tags "file://$(pwd)" "+refs/heads/*:refs/remotes/mirror/*" || true
    git -C "${STAGING_CODE}" fetch --no-tags origin "${DEFAULT_BRANCH}" || true
  else
    git -C "${STAGING_CODE}" fetch --no-tags origin "${DEFAULT_BRANCH}" || true
  fi
  git -C "${STAGING_CODE}" checkout --force "${sha}"
  git -C "${STAGING_CODE}" reset --hard "${sha}"
}

build_staging() {
  log "pnpm install --frozen-lockfile (staging)"
  (cd "${STAGING_CODE}" && pnpm install --frozen-lockfile)
  log "pnpm build (staging)"
  (cd "${STAGING_CODE}" && pnpm build)
}

# ── control-repo copy: realistic data, isolated actions ─────────────────────
refresh_control_copy() {
  [[ -d "${STAGING_CONTROL_SRC}" ]] || die "live control repo missing: ${STAGING_CONTROL_SRC}"
  mkdir -p "$(dirname "${STAGING_CONTROL}")"
  log "refreshing staging control copy ${STAGING_CONTROL_SRC} → ${STAGING_CONTROL}"
  # Full snapshot including .git so the staging daemon has a real control plane.
  # --delete keeps staging from accumulating orphan task files deleted in prod.
  rsync -a --delete \
    --exclude '.git/objects/pack/tmp_*' \
    --exclude '.git/index.lock' \
    "${STAGING_CONTROL_SRC}/" "${STAGING_CONTROL}/"
  reset_staging_shadow_store
  reset_staging_evidence_root
}

# ── M4 shadow store reset (cutover soak finding 4) ──────────────────────────
# The rsync above replaces the staging control repo's git history with prod's.
# Shadow projection envelopes bind to that history, so a store built against
# the previous copy fails startup integrity and crash-loops the daemon. The
# store is a derived shadow (never authority on staging), so drop it and let
# the daemon re-project from the fresh copy on boot. Env is scrubbed here, so
# the database path comes from the staging unit's env file.
reset_staging_shadow_store() {
  local env_file="${STAGING_ENV_FILE:-/home/ubuntu/.hercules/hercules-staging.env}"
  [[ -f "${env_file}" ]] || { log "no staging env file at ${env_file}; shadow reset skipped"; return 0; }
  local db
  db="$(sed -n 's/^HERCULES_V2_SHADOW_DATABASE=//p' "${env_file}" | tail -n1)"
  if [[ -z "${db}" ]]; then
    log "staging shadow store not configured; shadow reset skipped"
    return 0
  fi
  # Guard: only ever delete a staging-scoped store. Production has no shadow
  # store, and this script must never be able to reach one by misconfiguration.
  [[ "${db}" == *staging* ]] || die "refusing to reset non-staging shadow database: ${db}"
  local f
  for f in "${db}" "${db}-wal" "${db}-shm"; do
    if [[ -e "${f}" ]]; then
      [[ -f "${f}" ]] || die "shadow store path is not a regular file: ${f}"
      rm -f -- "${f}"
    fi
  done
  log "staging shadow store reset (${db}); daemon re-projects on boot"
}

# ── C3 evidence root reset (cutover phase C3) ───────────────────────────────
# The staging shadow store above is reset on every control-copy refresh, and
# the M5 archive metadata lives IN that store, so the archived bytes, exports
# and staged bundles under the staging evidence root would otherwise be
# orphans bound to a database that no longer exists. Drop their contents so the
# producers rebuild from the fresh projection. Staging-scoped paths only.
reset_staging_evidence_root() {
  local env_file="${STAGING_ENV_FILE:-/home/ubuntu/.hercules/hercules-staging.env}"
  [[ -f "${env_file}" ]] || { log "no staging env file at ${env_file}; evidence reset skipped"; return 0; }
  local root
  root="$(sed -n 's/^HERCULES_V2_EVIDENCE_ROOT=//p' "${env_file}" | tail -n1)"
  if [[ -z "${root}" ]]; then
    log "staging evidence root not configured; evidence reset skipped"
    return 0
  fi
  [[ "${root}" == *staging* ]] || die "refusing to reset non-staging evidence root: ${root}"
  [[ "${root}" == /* ]] || die "staging evidence root must be absolute: ${root}"
  if [[ -L "${root}" ]]; then die "staging evidence root is a symlink: ${root}"; fi
  if [[ ! -d "${root}" ]]; then
    log "staging evidence root ${root} absent; nothing to reset"
    return 0
  fi
  find "${root}" -mindepth 1 -delete
  log "staging evidence root reset (${root}); producers rebuild on boot"
}

# ── restart (user unit preferred; never interactive sudo) ───────────────────
restart_staging() {
  local unit="${STAGING_UNIT}"
  # Strip optional .service suffix for systemctl.
  unit="${unit%.service}"

  if systemctl --user cat "${unit}.service" >/dev/null 2>&1; then
    log "restarting user unit ${unit}"
    systemctl --user restart "${unit}.service"
    return 0
  fi

  if systemctl cat "${unit}.service" >/dev/null 2>&1; then
    if sudo -n systemctl restart "${unit}.service" 2>/dev/null; then
      log "restarted system unit ${unit} via sudo -n"
      return 0
    fi
    printf 'NEEDS-OPERATOR: sudo systemctl restart %s.service\n' "${unit}"
    log "staging tree is ready; operator must run the restart command above"
    exit 0
  fi

  # Unit not installed yet — first-time operator step (docs/deploy.md).
  printf 'NEEDS-OPERATOR: install hercules-staging unit then: sudo systemctl restart %s.service\n' "${unit}"
  log "staging tree built; unit '${unit}' not found — see docs/deploy.md"
  exit 0
}

# ── main ────────────────────────────────────────────────────────────────────
log "cwd=$(pwd)"
# Best-effort fetch when we are a normal checkout (bare mirrors are already refreshed by the daemon).
if ! is_bare; then
  git fetch --no-tags origin "${DEFAULT_BRANCH}" 2>/dev/null || true
fi

SHA="$(resolve_main_sha)"
URL="$(resolve_origin_url)"
log "main tip=${SHA}"

sync_staging_code "${SHA}" "${URL}"
build_staging
refresh_control_copy
restart_staging
log "staging deploy complete sha=${SHA:0:12}"
