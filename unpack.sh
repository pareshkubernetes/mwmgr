#!/usr/bin/env bash
# Recreate the whole workspace-mgr app from the text file made by pack.sh (all-code-file.txt).
# Needs only bash, awk and coreutils (sha256sum or shasum, base64, mktemp). Works in Git Bash on Windows.
#
#   bash unpack.sh all-code-file.txt                 recreate in the current directory
#   bash unpack.sh all-code-file.txt -o /some/dir    recreate in another directory (created if missing)
#   bash unpack.sh all-code-file.txt --dry-run       show what would happen, write nothing
#   bash unpack.sh all-code-file.txt --force         overwrite existing files that differ
#   bash unpack.sh all-code-file.txt --list          list the files in the bundle
#
# Every file is checked against its SHA-256 BEFORE anything is written to the target. Paths that could
# escape the target directory are rejected. Existing files that differ are never overwritten without --force.
# If an editor or git converted the file's line endings to CRLF, they are converted back, but only when the
# checksum proves the result is identical to the original.
# Afterwards:  npm ci && npm test && npm run build && npm start

set -euo pipefail
export LC_ALL=C

IN=""
OUT="."
FORCE=0
DRY=0
LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) OUT="${2:?-o needs a directory}"; shift 2 ;;
    -f|--force) FORCE=1; shift ;;
    -n|--dry-run) DRY=1; shift ;;
    -l|--list) LIST=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unpack: unknown argument: $1" >&2; exit 1 ;;
    *) if [ -z "$IN" ]; then IN="$1"; else echo "unpack: unexpected argument: $1" >&2; exit 1; fi; shift ;;
  esac
done

if [ -z "$IN" ]; then
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
[ -f "$IN" ] || { echo "unpack: no such file: $IN" >&2; exit 1; }

# Accept Windows-style paths (C:\dir) when running under Git Bash / MSYS / Cygwin.
if command -v cygpath >/dev/null 2>&1 && printf '%s' "$OUT" | grep -Eq '^[A-Za-z]:[\\/]'; then
  OUT="$(cygpath -u "$OUT")"
fi

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo "unpack: need sha256sum or shasum to verify files" >&2; exit 1; fi
}

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
MANIFEST="$STAGE/.manifest"
: > "$MANIFEST"
mkdir -p "$STAGE/files"

# ---- 1. split the text file into a staging directory (nothing touches the target yet) -----------------
# extract STRIP: with STRIP=1 exactly one CR is removed from every line, which undoes a naive LF -> CRLF
# conversion of the whole text file. It is done here, byte-exact, because the Windows sed/awk text modes would
# also eat the CR of a file that legitimately has CRLF endings.
# BINMODE=3: gawk on Windows (Git Bash) otherwise strips the CR from CRLF files; other awks ignore it.
extract() {  # extract STRIP STAGE_DIR MANIFEST_FILE
rm -rf "$2"; mkdir -p "$2"; : > "$3"
awk -v BINMODE=3 -v strip="$1" -v stage="$2" -v manifest="$3" '
function fail(msg) { print "unpack: " msg > "/dev/stderr"; failed = 1; exit 1 }
function safe(p,   t) {
  if (p == "" || p ~ /^\// || p !~ /^[A-Za-z0-9._@+=, \/-]+$/) return 0
  if (p ~ /\/\// || p ~ /\/$/) return 0
  t = "/" p "/"
  if (t ~ /\/\.\.\// || t ~ /\/\.\//) return 0
  return 1
}
function finish(   cmd) {
  if (enc == "b64") {
    close(pipecmd)
  } else {
    if (!have) printf "" > outpath
    else if (nl == "nl") printf "%s\n", prev > outpath
    else {
      # strip=2: git turned the newline pack.sh appended after a file with no final newline into CRLF
      if (strip + 0 == 2) sub(/\r$/, "", prev)
      printf "%s", prev > outpath
    }
    close(outpath)
  }
  print path "\t" sha "\t" enc >> manifest
  infile = 0; count++
}
{
  if (strip + 0 == 1) sub(/\r$/, "")
  m = $0; sub(/\r$/, "", m)
  if (!infile) {
    if (m ~ /^#### token: /) { tok = substr(m, 13); next }
    if (m ~ /^#### files: /) { declared = substr(m, 13) + 0; next }
    if (tok != "" && index(m, "@@@FILE@" tok " ") == 1) {
      rest = substr(m, length("@@@FILE@" tok " ") + 1)
      n = split(rest, a, " ")
      if (n < 4) fail("malformed file header: " m)
      enc = a[1]; nl = a[2]; sha = a[3]
      path = substr(rest, length(a[1]) + length(a[2]) + length(a[3]) + 4)
      if (!safe(path)) fail("unsafe path in bundle: " path)
      if (path in seen) fail("duplicate path in bundle: " path)
      if (enc != "text" && enc != "b64") fail("unknown encoding \"" enc "\" for " path)
      seen[path] = 1
      outpath = stage "/" path
      dir = outpath; sub(/\/[^\/]*$/, "", dir)
      system("mkdir -p \"" dir "\"")
      have = 0; prev = ""; infile = 1
      if (enc == "b64") pipecmd = "base64 -d > \"" outpath "\""
      next
    }
    next
  }
  if (index(m, "@@@END@" tok) == 1 && m == "@@@END@" tok) { finish(); next }
  if (enc == "b64") { print m | pipecmd; next }
  if (have) printf "%s\n", prev > outpath
  prev = $0; have = 1
}
END {
  if (failed) exit 1
  if (infile) fail("missing end marker for " path " (truncated file?)")
  if (tok == "") fail("not a workspace-mgr bundle (no token header found)")
  if (count != declared) fail("bundle declares " declared " files but contains " count)
}
' "$IN"
}

# ---- 2. verify every file against its recorded SHA-256 (repairing CRLF conversion if provable) --------
extract 0 "$STAGE/files" "$MANIFEST"

bad_files=()
while IFS=$'\t' read -r path sum enc; do
  [ -n "$path" ] || continue
  [ "$(hash_of "$STAGE/files/$path")" = "$sum" ] || bad_files+=("$path")
done < "$MANIFEST"

REPAIRED=0
if [ "${#bad_files[@]}" -gt 0 ]; then
  # Did an editor, e-mail client or git (autocrlf) change the line endings of the text file? Converters differ:
  # some add a CR to EVERY line, git adds one only to lines that ended in a bare LF, so files that already had
  # CRLF stay untouched (except the newline pack.sh adds after a file with no final newline). So repair FILE BY
  # FILE with these candidates, and accept one only when it matches the recorded SHA-256; otherwise refuse:
  #   1 = remove one CR from every line      2 = remove one CR from the last line of a no-final-newline file
  if head -n 1 "$IN" | od -An -c | grep -q '\\r'; then
    extract 1 "$STAGE/files1" "$STAGE/.manifest1"
    extract 2 "$STAGE/files2" "$STAGE/.manifest2"
    still_bad=()
    for path in "${bad_files[@]}"; do
      want="$(awk -F '\t' -v p="$path" '$1 == p { print $2; exit }' "$MANIFEST")"
      fixed=0
      for candidate in files1 files2; do
        if [ -f "$STAGE/$candidate/$path" ] && [ "$(hash_of "$STAGE/$candidate/$path")" = "$want" ]; then
          cp "$STAGE/$candidate/$path" "$STAGE/files/$path"
          fixed=1
          break
        fi
      done
      if [ "$fixed" = 1 ]; then REPAIRED=$((REPAIRED + 1)); else still_bad+=("$path"); fi
    done
    bad_files=("${still_bad[@]+"${still_bad[@]}"}")
  fi
  if [ "${#bad_files[@]}" -gt 0 ]; then
    echo "unpack: checksum mismatch for ${bad_files[0]}$([ "${#bad_files[@]}" -gt 1 ] && echo " and $((${#bad_files[@]} - 1)) more") (the text file was edited or damaged in transit, not just line-ending converted); nothing was written" >&2
    exit 1
  fi
fi
[ "$REPAIRED" -gt 0 ] && echo "Note: $REPAIRED file(s) had their line endings changed in transit (editor/e-mail/git autocrlf?); converted back, and every file matches its checksum." >&2

TOTAL="$(grep -c . "$MANIFEST" || true)"

if [ "$LIST" = 1 ]; then
  while IFS=$'\t' read -r path sum enc; do
    [ -n "$path" ] && printf '%s  (%s bytes, %s)\n' "$path" "$(wc -c < "$STAGE/files/$path" | tr -d ' ')" "$enc"
  done < "$MANIFEST"
  echo; echo "$TOTAL file(s)"
  exit 0
fi

# ---- 3. copy into the target, never clobbering differing files unless --force -----------------------------
created=0; overwritten=0; unchanged=0; skipped=0
[ "$DRY" = 1 ] || mkdir -p "$OUT"
while IFS=$'\t' read -r path sum enc; do
  [ -n "$path" ] || continue
  src="$STAGE/files/$path"
  dst="$OUT/$path"
  if [ ! -e "$dst" ]; then action=created
  elif [ ! -f "$dst" ]; then action=skipped
  elif cmp -s "$src" "$dst"; then action=unchanged
  elif [ "$FORCE" = 1 ]; then action=overwritten
  else action=skipped; fi

  if [ "$DRY" = 0 ] && { [ "$action" = created ] || [ "$action" = overwritten ]; }; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    case "$path" in *.sh) chmod +x "$dst" 2>/dev/null || true ;; esac
  fi
  case "$action" in
    created) created=$((created + 1)) ;;
    overwritten) overwritten=$((overwritten + 1)) ;;
    unchanged) unchanged=$((unchanged + 1)) ;;
    skipped) skipped=$((skipped + 1)) ;;
  esac
  note=""; [ "$action" = skipped ] && note="  (exists and differs; use --force to overwrite)"
  label="$action"; [ "$DRY" = 1 ] && label="would be $action"
  printf '%-20s%s%s\n' "$label" "$path" "$note"
done < "$MANIFEST"

echo
[ "$DRY" = 1 ] && printf 'Dry run: '
echo "$created created, $overwritten overwritten, $unchanged unchanged, $skipped skipped -> $OUT"
[ "$skipped" -gt 0 ] && exit 2
exit 0
