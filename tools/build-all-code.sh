#!/usr/bin/env bash
# tools/build-all-code.sh   (maintainer tool: it is NOT part of a hand-over; the other computer only needs recreate-app.sh)
#
# Writes all-app-code.txt, the hand-over file that recreate-app.sh turns back into files on another computer.
#   * first run (nothing handed over yet) ......... the ENTIRE application
#   * every later run ............................. only files that are new or changed since the last hand-over,
#                                                   plus a list of files that were removed
#
# Usage (run it in the app folder):
#     bash tools/build-all-code.sh               # entire app the first time, then only what changed
#     bash tools/build-all-code.sh --full        # the entire app again (e.g. for a brand-new folder)
#     bash tools/build-all-code.sh --list        # show what would be included; write nothing, record nothing
#     bash tools/build-all-code.sh --keep-state  # build the file but do not record it as handed over
#     bash tools/build-all-code.sh --redo        # build the PREVIOUS hand-over again (e.g. it never arrived)
#     bash tools/build-all-code.sh --out p.txt   # another output file name
#
# Which hand-over the other computer has is remembered in .handover-state (file name + SHA-256 of every file).
# Not packed, ever: node_modules, dist, coverage, .git, legacy, .env* (secrets), certificate private keys.
# The file is checked before it is saved: it is recreated in a temp folder and compared byte for byte with your files.

set -euo pipefail
export LC_ALL=C
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT="all-app-code.txt"
STATE=".handover-state"
FULL=0; LIST=0; KEEP=0; REDO=0

usage() { sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { echo "build-all-code: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1; shift ;;
    --list|--dry-run) LIST=1; shift ;;
    --keep-state) KEEP=1; shift ;;
    --redo) REDO=1; KEEP=1; shift ;;
    --out) OUT="${2:?--out needs a file name}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

DIRS=(src tests scripts docs helm kustomize.server base overlays certs)
ROOT_FILES=(README.md package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts
  eslint.config.js .prettierrc.json .prettierignore .gitignore .gitattributes .dockerignore .env.example Dockerfile
  recreate-app.sh)

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "need sha256sum or shasum"; fi
}

is_excluded() {
  case "/$1/" in
    */node_modules/*|*/dist/*|*/coverage/*|*/.git/*|*/legacy/*|*/.idea/*|*/.vscode/*) return 0 ;;
  esac
  case "$1" in
    .env|.env.*|*/.env|*/.env.*) [ "$(basename "$1")" = ".env.example" ] || return 0 ;;
    "$OUT"|all-app-code*.txt|.handover-state|.handover-state.prev|*.bundle.txt|*.log|.DS_Store|*/.DS_Store|Thumbs.db) return 0 ;;
  esac
  return 1
}

collect() {
  local f d
  for f in "${ROOT_FILES[@]}"; do [ -f "$f" ] && printf '%s\n' "$f"; done
  for d in "${DIRS[@]}"; do [ -d "$d" ] && find "$d" -type f; done
}

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

# ---- 1. which files are part of the app -------------------------------------------------------------------
FILES=()
while IFS= read -r f; do
  f="${f#./}"
  is_excluded "$f" && continue
  case "$f" in *\\*|*$'\n'*) die "refusing a file name with a backslash or newline: $f" ;; esac
  if grep -qE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$f" 2>/dev/null; then
    die "refusing to pack $f: it contains a private key"
  fi
  FILES+=("$f")
done < <(collect | sort -u)
[ "${#FILES[@]}" -gt 0 ] || die "no application files found"

: > "$T/current"
for f in "${FILES[@]}"; do printf '%s\t%s\n' "$(hash_of "$f")" "$f" >> "$T/current"; done

# ---- 2. what goes into this hand-over -----------------------------------------------------------------------
BASE=""
if [ "$FULL" = 0 ]; then
  if [ "$REDO" = 1 ]; then
    [ -f "$STATE.prev" ] || die "there is no previous hand-over to redo"
    BASE="$STATE.prev"
  elif [ -f "$STATE" ]; then
    BASE="$STATE"
  fi
fi

: > "$T/removed"
if [ -z "$BASE" ]; then
  MODE="entire app"
  cut -f2 "$T/current" > "$T/include"
  # Full snapshots also carry deletions for an existing installation.
  REMOVAL_BASE="$STATE"
  [ "$REDO" = 1 ] && REMOVAL_BASE="$STATE.prev"
  if [ -f "$REMOVAL_BASE" ]; then
    cut -f2 "$T/current" | sort -u > "$T/cur.paths"
    cut -f2 "$REMOVAL_BASE" | sort -u > "$T/base.paths"
    comm -13 "$T/cur.paths" "$T/base.paths" > "$T/removed"
  fi
else
  MODE="updated files only"
  sort "$T/current" > "$T/cur.sorted"
  sort "$BASE" > "$T/base.sorted"
  comm -23 "$T/cur.sorted" "$T/base.sorted" | cut -f2 | sort -u > "$T/include"
  cut -f2 "$T/cur.sorted" | sort -u > "$T/cur.paths"
  cut -f2 "$T/base.sorted" | sort -u > "$T/base.paths"
  comm -13 "$T/cur.paths" "$T/base.paths" > "$T/removed"
fi

if [ ! -s "$T/include" ] && [ ! -s "$T/removed" ]; then
  echo "Nothing changed since the last hand-over: no file written. (--full gives the entire app, --redo the previous hand-over)"
  exit 0
fi

if [ "$LIST" = 1 ]; then
  echo "Mode: $MODE"
  while IFS= read -r f; do echo "  $f"; done < "$T/include"
  if [ -s "$T/removed" ]; then echo "Removed since the last hand-over:"; while IFS= read -r f; do echo "  $f"; done < "$T/removed"; fi
  echo; echo "$(grep -c . "$T/include" || true) file(s) to include, $(grep -c . "$T/removed" || true) removed"
  exit 0
fi

# ---- 3. plain text where it is safe, base64 where it is not ------------------------------------------------
: > "$T/force64"

# A file is shown as plain text only if recreate-app.sh gives back exactly the same bytes: LF line endings, a final
# newline, no blank first/last line, a simple name, and no line that could be mistaken for a marker or a path.
plain_ok() {
  local f="$1" base
  grep -qxF -- "$f" "$T/force64" && return 1
  [[ "$f" =~ ^[A-Za-z0-9_.@~+/-]+$ ]] || return 1
  case "$f" in *//*|*..*) return 1 ;; esac
  base="${f##*/}"
  case "$base" in *.*|Dockerfile|Makefile|LICENSE|Procfile) ;; *) return 1 ;; esac
  [ -s "$f" ] || return 0
  tr -d '\000\r' < "$f" | cmp -s - "$f" || return 1
  [ -z "$(tail -c1 "$f")" ] || return 1
  [ -n "$(head -n1 "$f")" ] || return 1
  [ -n "$(tail -n1 "$f")" ] || return 1
  grep -qE '^@@(BINARY-SECTION|CHECKSUMS|FILE |END)' "$f" && return 1
  grep -qE '^/[A-Za-z0-9_.@~+-][A-Za-z0-9_.@~+/-]*$' "$f" && return 1
  return 0
}

generate() {
  : > "$T/plain"; : > "$T/b64"
  local f r h p
  while IFS= read -r f; do
    if plain_ok "$f"; then echo "$f" >> "$T/plain"; else echo "$f" >> "$T/b64"; fi
  done < "$T/include"
  {
    echo "# all-app-code.txt - $MODE - generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# On the other computer, inside the app folder:   bash recreate-app.sh -f --prune"
    echo "# Includes source, tests, configuration templates and checksums; excludes secrets and installed dependencies."
    echo "# Install dependencies from the configured internal npm repository."
    echo
    while IFS= read -r f; do printf '/%s\n' "$f"; cat "$f"; echo; done < "$T/plain"
    if [ -s "$T/removed" ]; then
      echo "/_REMOVED.txt"
      while IFS= read -r r; do printf '/%s\n' "$r"; done < "$T/removed"
      echo
    fi
    if [ -s "$T/b64" ]; then
      echo "@@BINARY-SECTION"
      while IFS= read -r f; do printf '@@FILE /%s\n' "$f"; base64 < "$f"; echo "@@END"; done < "$T/b64"
    fi
    echo "@@CHECKSUMS"
    awk -F '\t' 'NR == FNR { inc[$0] = 1; next } ($2 in inc) { print $1 "  /" $2 }' "$T/include" "$T/current"
  } > "$T/out"
}

# Recreate the hand-over in a temp folder with the real recreate-app.sh and compare with the real files.
roundtrip() {
  local R="$T/rt" f
  rm -rf "$R"; mkdir "$R"; : > "$T/newforce"
  bash ./recreate-app.sh "$T/out" "$R" > "$T/rt.log" 2>&1 || { cat "$T/rt.log" >&2; return 2; }
  while IFS= read -r f; do cmp -s "$f" "$R/$f" || echo "$f" >> "$T/newforce"; done < "$T/include"
  [ ! -s "$T/newforce" ]
}

rc=1
for attempt in 1 2 3; do
  generate
  rc=0; roundtrip || rc=$?
  [ "$rc" = 0 ] && break
  [ "$rc" = 2 ] && die "the generated file could not be recreated (see above); nothing was saved"
  # Anything that did not come back identical as plain text is stored as base64 instead.
  while IFS= read -r f; do
    grep -qxF -- "$f" "$T/b64" && die "$f cannot be recreated exactly even as base64 (internal error); nothing was saved"
    echo "$f" >> "$T/force64"
  done < "$T/newforce"
done
[ "$rc" = 0 ] || die "could not build a hand-over that recreates exactly; nothing was saved"

# ---- 4. save it, and remember what the other computer now has ------------------------------------------------
cp "$T/out" "$OUT"
if [ "$KEEP" = 0 ]; then
  [ -f "$STATE" ] && cp "$STATE" "$STATE.prev"
  cp "$T/current" "$STATE"
fi

n_in="$(grep -c . "$T/include" || true)"; n_rm="$(grep -c . "$T/removed" || true)"; n_b="$(grep -c . "$T/b64" || true)"
kib=$(( $(wc -c < "$OUT" | tr -d ' ') / 1024 ))
if [ -z "$BASE" ]; then
  echo "Entire app: $n_in file(s), $kib KiB -> $OUT"
else
  echo "Updated files only: $n_in new or changed, $n_rm removed, $kib KiB -> $OUT"
fi
if [ "$n_b" -gt 0 ]; then
  echo "$n_b file(s) are stored as base64 because they cannot be shown as exact plain text (CRLF line endings, no final newline, odd name):"
  sed 's/^/  /' "$T/b64"
fi
if [ "$KEEP" = 1 ]; then echo "(not recorded as handed over)"; else echo "Recorded in $STATE."; fi
echo
echo "On the other computer, inside the app folder:   bash recreate-app.sh -f"
[ "$n_rm" -gt 0 ] && echo "(add --prune to also delete the $n_rm removed file(s))"
exit 0
