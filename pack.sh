#!/usr/bin/env bash
# Pack every file needed to run, build and test workspace-mgr into ONE text file.
# Rebuild the app from that file with:  bash unpack.sh all-code-file.txt
#
#   bash pack.sh                   -> all-code-file.txt
#   bash pack.sh -o other.txt      choose the output file
#   bash pack.sh --list            only list the files that would be packed
#
# Included : src, tests, scripts, docs, helm, kustomize.server, base, overlays, certs (if present),
#            README.md, package.json, package-lock.json, tsconfig*.json, vitest/eslint/prettier configs,
#            Dockerfile, .dockerignore, .gitignore, .env.example, pack.sh, unpack.sh
#            (no migrations: the Postgres table already exists and is never created by the app)
# Refused  : any file containing a private key (certs/ may hold public CA bundles only)
# Excluded : node_modules, dist, coverage, .git, legacy, prompt, .env (secrets), *.bundle.txt, the output file

set -euo pipefail
export LC_ALL=C

cd "$(dirname "${BASH_SOURCE[0]}")"
OUT="all-code-file.txt"
LIST_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT="${2:?-o needs a file name}"; shift 2 ;;
    --list) LIST_ONLY=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "pack: unknown argument: $1" >&2; exit 1 ;;
  esac
done

DIRS=(src tests scripts docs helm kustomize.server base overlays certs)
ROOT_FILES=(README.md package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts
  eslint.config.js .prettierrc.json .prettierignore .gitignore .gitattributes .dockerignore .env.example Dockerfile
  pack.sh unpack.sh)

collect() {
  for f in "${ROOT_FILES[@]}"; do [ -f "$f" ] && printf '%s\n' "$f"; done
  for d in "${DIRS[@]}"; do [ -d "$d" ] && find "$d" -type f; done
}

is_excluded() {
  case "/$1/" in
    */node_modules/*|*/dist/*|*/coverage/*|*/.git/*|*/legacy/*) return 0 ;;
  esac
  case "$1" in
    .env|.env.*|*/.env|*/.env.*) [ "$(basename "$1")" = ".env.example" ] || return 0 ;;
    *.bundle.txt|*.log|"$OUT") return 0 ;;
  esac
  return 1
}

FILES=()
while IFS= read -r f; do
  f="${f#./}"
  is_excluded "$f" && continue
  case "$f" in *[\'\"\\:]*|*$'\n'*) echo "pack: refusing unsafe file name: $f" >&2; exit 1 ;; esac
  FILES+=("$f")
done < <(collect | sort -u)

if [ "$LIST_ONLY" = 1 ]; then
  printf '%s\n' "${FILES[@]}"
  echo "${#FILES[@]} file(s)" >&2
  exit 0
fi

for f in "${FILES[@]}"; do
  if grep -qE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$f" 2>/dev/null; then
    echo "pack: refusing to pack $f: it contains a private key" >&2
    exit 1
  fi
done

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Random marker token; if any file happened to contain it we would simply pick another.
TOKEN=""
while :; do
  TOKEN="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  clash=0
  for f in "${FILES[@]}"; do
    if grep -qF "@@@FILE@$TOKEN" "$f" 2>/dev/null || grep -qF "@@@END@$TOKEN" "$f" 2>/dev/null; then clash=1; break; fi
  done
  [ "$clash" = 0 ] && break
done

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  echo "#### WORKSPACE-MGR ALL-CODE-FILE v1"
  echo "#### generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "#### token: $TOKEN"
  echo "#### files: ${#FILES[@]}"
  echo "#### rebuild the app with: bash unpack.sh $(basename "$OUT") [-o DIR] [--force]"
  echo
  for f in "${FILES[@]}"; do
    sum="$(hash_of "$f")"
    if [ ! -s "$f" ]; then
      printf '@@@FILE@%s text empty %s %s\n' "$TOKEN" "$sum" "$f"
    elif [ "$(tr -d '\000' < "$f" | cmp -s - "$f" && echo text || echo binary)" = binary ]; then
      printf '@@@FILE@%s b64 nl %s %s\n' "$TOKEN" "$sum" "$f"
      base64 < "$f"
    else
      if [ -n "$(tail -c1 "$f")" ]; then nl=nonl; else nl=nl; fi
      printf '@@@FILE@%s text %s %s %s\n' "$TOKEN" "$nl" "$sum" "$f"
      cat "$f"
      [ "$nl" = nonl ] && printf '\n'
    fi
    printf '@@@END@%s\n' "$TOKEN"
  done
} > "$TMP"

mv "$TMP" "$OUT"
trap - EXIT
bytes="$(wc -c < "$OUT" | tr -d ' ')"
echo "Packed ${#FILES[@]} file(s), $((bytes / 1024)) KiB -> $OUT"
