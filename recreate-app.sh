#!/usr/bin/env bash
# recreate-app.sh
#
# Writes the files of all-app-code.txt into the app folder. The first hand-over holds the ENTIRE application;
# after that the file holds only what changed since the last hand-over (new files, changed files, a removal list).
# It is made by build-all-code.sh.
#
# all-app-code.txt format:
#     /relative/path/to/file.ext      <- path line (starts with "/")
#     ...file content...
#                                     <- one blank separator line
#     /_REMOVED.txt                   <- (only when needed) files that no longer belong to the app, one per line
#     @@BINARY-SECTION                <- (only when needed) files that cannot be shown as plain text (CRLF files,
#     @@FILE /docs/img/x.png             no final newline, odd names, pictures ...) as base64 text:
#         ...base64 lines...             then  @@END
#     @@CHECKSUMS                     <- SHA-256 of every file in the hand-over; checked BEFORE anything is written
#
# Usage (run it inside the app folder):
#     bash recreate-app.sh -f                      # reads ./all-app-code.txt, overwrites what is there   <- normal use
#     bash recreate-app.sh -f p.txt                # another input file name
#     bash recreate-app.sh -f --prune              # also delete the files listed under /_REMOVED.txt
#     bash recreate-app.sh p.txt ./out             # write into another folder (existing files are kept without -f)
#     bash recreate-app.sh -n                      # dry run: show what would happen, write nothing
#     bash recreate-app.sh -l                      # list the files in the hand-over
#     bash recreate-app.sh -f --no-verify          # skip the checksum check (only for a text file you edited by hand)
#
# Without -f existing files that differ are NOT overwritten (they are reported and skipped); identical ones are left alone.
# Safe against line-ending changes: if an editor, e-mail or git converts the text file to CRLF, nothing is damaged.
# At the end it tells you what to run next (npm install, npm run build ...) - only when it is needed.

set -euo pipefail
export LC_ALL=C

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

hash_tool() {
  if command -v sha256sum >/dev/null 2>&1; then echo sha256sum
  elif command -v shasum >/dev/null 2>&1; then echo "shasum -a 256"
  fi
}

usage() { sed -n '2,30p' "$SELF" | sed 's/^# \{0,1\}//'; }

# Everything lives in main() and the script ends with "exit" on the same line that calls it, so bash never reads
# the file again after main starts: a hand-over may safely contain a newer version of this very script.
main() {
  local FORCE=0 PRUNE=0 DRY=0 LIST=0 NOVERIFY=0 a
  local POS=()
  for a in "$@"; do
    case "$a" in
      -f|--force) FORCE=1 ;;
      --prune) PRUNE=1 ;;
      --no-verify) NOVERIFY=1 ;;
      -n|--dry-run) DRY=1 ;;
      -l|--list) LIST=1 ;;
      -h|--help) usage; return 0 ;;
      -*) echo "ERROR: unknown option: $a" >&2; return 1 ;;
      *) POS+=("$a") ;;
    esac
  done

  local INPUT="${POS[0]:-all-app-code.txt}"
  local TARGET="${POS[1]:-.}"
  if [ ! -f "$INPUT" ]; then
    echo "ERROR: input file not found: $INPUT" >&2
    return 1
  fi
  # Windows-style target (C:\dir) under Git Bash
  if command -v cygpath >/dev/null 2>&1 && printf '%s' "$TARGET" | grep -Eq '^[A-Za-z]:[\\/]'; then
    TARGET="$(cygpath -u "$TARGET")"
  fi

  STAGE="$(mktemp -d)"            # global on purpose: the EXIT trap runs after main() has returned
  trap 'rm -rf "$STAGE"' EXIT
  mkdir -p "$STAGE/files"
  : > "$STAGE/list"; : > "$STAGE/removed"; : > "$STAGE/binlist"; : > "$STAGE/sums"

  # ---- 1. plain-text files and the removal list -> staging (nothing touches the target yet) ---------------
  # BINMODE=3: gawk on Windows (Git Bash) must not translate line endings; every CR is removed explicitly below.
  awk -v BINMODE=3 -v stage="$STAGE/files" -v listf="$STAGE/list" -v remf="$STAGE/removed" '
  function shq(s) { gsub(/\047/, "\047\\\047\047", s); return "\047" s "\047" }
  function safe_path(p,   n, parts, i) {
    if (p !~ /^\//) return 0
    if (p ~ /\/\// || p ~ /\\/ || p ~ /\/$/) return 0
    n = split(p, parts, "/")
    for (i = 2; i <= n; i++) if (parts[i] == ".." || parts[i] == ".") return 0
    return 1
  }
  # A path line: starts with a single "/", no spaces, a normal file name
  # (has an extension, or is a well-known extensionless name).
  function is_path(l,    base, n, parts) {
    if (l !~ /^\/[A-Za-z0-9_.@~+\-]/) return 0
    if (l ~ /^\/\//) return 0
    if (l ~ /^\/\*/) return 0
    if (l ~ /[ \t]/) return 0
    if (l !~ /^\/[A-Za-z0-9_.@~+\/\-]+$/) return 0
    if (!safe_path(l)) return 0
    n = split(l, parts, "/")
    base = parts[n]
    if (base == "") return 0
    if (base ~ /\./) return 1
    if (base == "Dockerfile" || base == "Makefile" || base == "LICENSE" || base == "Procfile") return 1
    return 0
  }
  function open_file(path,    full, dir) {
    if (cur != "") close(cur)
    removing = 0
    if (path == "/_REMOVED.txt") { removing = 1; cur = ""; return }     # a list, not a file
    full = stage path
    dir = full
    sub(/\/[^\/]*$/, "", dir)
    system("mkdir -p " shq(dir))
    cur = full
    printf "" > cur                      # create / truncate
    print path >> listf
  }
  BEGIN { stop = 0; held = 0; started = 0; cur = ""; removing = 0 }
  {
    line = $0
    sub(/\r$/, "", line)

    if (line == "@@BINARY-SECTION" || line == "@@CHECKSUMS") stop = 1   # base64 files and checksums follow
    if (stop) next

    if (line == "") {
      if (held && cur != "") printf "\n" >> cur
      held = 1
      next
    }
    if ((!started || held) && is_path(line)) {
      started = 1
      held = 0                           # this blank line was the separator
      open_file(line)
      next
    }
    if (!started) next                   # ignore anything before the first path (the comment header)
    if (removing) {                      # inside /_REMOVED.txt
      held = 0
      if (is_path(line)) print line >> remf
      next
    }
    if (held) {
      if (cur != "") printf "\n" >> cur
      held = 0
    }
    if (cur != "") print line >> cur
  }
  END { if (cur != "") close(cur) }
  ' "$INPUT"

  # ---- 2. base64 files -> staging ------------------------------------------------------------------------
  if grep -q '^@@BINARY-SECTION' "$INPUT"; then
    awk -v BINMODE=3 -v stage="$STAGE/files" -v listf="$STAGE/list" -v binf="$STAGE/binlist" '
    function shq(s) { gsub(/\047/, "\047\\\047\047", s); return "\047" s "\047" }
    function safe_path(p,   n, parts, i) {
      if (p !~ /^\//) return 0
      if (p ~ /\/\// || p ~ /\\/ || p ~ /\/$/) return 0
      n = split(p, parts, "/")
      for (i = 2; i <= n; i++) if (parts[i] == ".." || parts[i] == ".") return 0
      return 1
    }
    { sub(/\r$/, "") }
    /^@@BINARY-SECTION/ { on = 1; next }
    /^@@CHECKSUMS/ { if (out != "") close(out); out = ""; on = 0; next }
    !on { next }
    /^@@END/ { if (out != "") close(out); out = ""; next }
    /^@@FILE / {
      if (out != "") close(out)
      p = substr($0, 8)
      if (!safe_path(p)) { print "ERROR: unsafe path in the hand-over: " p > "/dev/stderr"; bad = 1; exit 1 }
      full = stage p; dir = full; sub(/\/[^\/]*$/, "", dir)
      system("mkdir -p " shq(dir))
      out = full ".b64"; printf "" > out
      print p >> listf; print full >> binf
      next
    }
    { if (out != "") print $0 >> out }
    END { if (out != "") close(out); if (bad) exit 1 }
    ' "$INPUT"
    local f
    while IFS= read -r f; do
      if base64 -d "$f.b64" > "$f" 2>/dev/null; then rm -f "$f.b64"
      else echo "ERROR: could not decode base64 data for ${f#"$STAGE/files"}; nothing was written" >&2; return 1; fi
    done < "$STAGE/binlist"
  fi

  # ---- 3. check every file against its SHA-256 BEFORE writing anything -------------------------------------
  awk -v BINMODE=3 '
    { sub(/\r$/, "") }
    /^@@CHECKSUMS/ { on = 1; next }
    on && NF >= 2 { print $1 "\t" substr($0, length($1) + 3) }
  ' "$INPUT" > "$STAGE/sums"

  local tool; tool="$(hash_tool)"
  if [ -s "$STAGE/sums" ] && [ -n "$tool" ]; then
    local sum path got badn=0 bad1=""
    while IFS=$'\t' read -r sum path; do
      [ -n "$path" ] || continue
      if [ ! -f "$STAGE/files$path" ]; then got="(missing)"; else got="$($tool "$STAGE/files$path" | cut -d' ' -f1)"; fi
      if [ "$got" != "$sum" ]; then badn=$((badn + 1)); [ -n "$bad1" ] || bad1="$path"; fi
    done < "$STAGE/sums"
    # a file without a checksum would be unverified (hand-added, or a damaged text file)
    cut -f2 "$STAGE/sums" | sort -u > "$STAGE/sums.paths"
    sort -u "$STAGE/list" | comm -23 - "$STAGE/sums.paths" > "$STAGE/nosum"
    if [ -s "$STAGE/nosum" ]; then
      badn=$((badn + $(grep -c . "$STAGE/nosum")))
      [ -n "$bad1" ] || bad1="$(head -n1 "$STAGE/nosum") (no checksum)"
    fi
    if [ "$badn" -gt 0 ]; then
      if [ "$NOVERIFY" = 1 ]; then
        echo "warning: $badn file(s) did not match their checksum (first: $bad1); continuing because of --no-verify" >&2
      else
        echo "ERROR: checksum mismatch for $bad1$([ "$badn" -gt 1 ] && echo " and $((badn - 1)) more"): the text file was edited or damaged in transit. Nothing was written." >&2
        echo "       (a deliberate hand edit can be applied with --no-verify)" >&2
        return 1
      fi
    fi
  elif [ "$NOVERIFY" = 1 ]; then
    echo "note: files were not verified (--no-verify)" >&2
  elif [ ! -s "$STAGE/sums" ]; then
    echo "ERROR: the text file has no @@CHECKSUMS section: it is incomplete (cut off while copying?) or written by hand. Nothing was written." >&2
    echo "       (use --no-verify to accept it anyway)" >&2
    return 1
  else
    echo "ERROR: sha256sum/shasum not found, so the files cannot be verified. Nothing was written. (use --no-verify to skip)" >&2
    return 1
  fi

  local total; total="$(sort -u "$STAGE/list" | grep -c . || true)"
  if [ "$LIST" = 1 ]; then
    sort -u "$STAGE/list"
    echo
    echo "$total file(s), $(grep -c . "$STAGE/removed" || true) to remove"
    return 0
  fi
  if [ "$total" = 0 ]; then echo "The hand-over holds no files."; return 0; fi

  # ---- 4. copy into the target ------------------------------------------------------------------------------
  [ "$DRY" = 1 ] || mkdir -p "$TARGET"
  TARGET="$(cd "$TARGET" 2>/dev/null && pwd || printf '%s' "$TARGET")"
  local created=0 overwritten=0 unchanged=0 skipped=0 deferred=0 action src dst
  : > "$STAGE/applied"
  while IFS= read -r path; do
    src="$STAGE/files$path"; dst="$TARGET$path"
    if [ ! -e "$dst" ]; then action=created
    elif [ -f "$dst" ] && cmp -s "$src" "$dst"; then action=unchanged
    elif [ "$FORCE" = 1 ]; then action=overwritten
    else action=skipped; fi

    case "$action" in
      created|overwritten)
        if [ "$DRY" = 0 ]; then
          mkdir -p "$(dirname "$dst")"
          if [ "$dst" = "$SELF" ]; then
            # Do not replace the running script (Windows locks it): leave the new version next to it.
            cp "$src" "$dst.new"; deferred=1
            echo "  new version saved as ${path#/}.new  (run: mv ${path#/}.new ${path#/})"
          else
            cp "$src" "$dst"
          fi
          case "$path" in *.sh) chmod +x "$dst" 2>/dev/null || true ;; esac
        fi
        [ "$action" = created ] && created=$((created + 1)) || overwritten=$((overwritten + 1))
        echo "$path" >> "$STAGE/applied"
        ;;
      unchanged) unchanged=$((unchanged + 1)) ;;
      skipped) skipped=$((skipped + 1)); echo "  skipped (exists and differs): ${path#/}" ;;
    esac
  done < <(sort -u "$STAGE/list")

  printf '%s%d written (%d new, %d overwritten), %d already identical, %d skipped.\n' \
    "$([ "$DRY" = 1 ] && echo 'Dry run: ' || true)" "$((created + overwritten))" "$created" "$overwritten" "$unchanged" "$skipped"
  [ "$skipped" -gt 0 ] && echo "(use -f to overwrite existing files)"

  # ---- 5. files that no longer belong to the app -------------------------------------------------------------
  if [ -s "$STAGE/removed" ]; then
    local r any=0
    while IFS= read -r r; do
      if [ -e "$TARGET$r" ]; then
        if [ "$any" = 0 ]; then echo; echo "These files are no longer part of the app:"; any=1; fi
        if [ "$PRUNE" = 1 ] && [ "$DRY" = 0 ]; then rm -f "$TARGET$r" && echo "  deleted   ${r#/}"; else echo "  delete    ${r#/}"; fi
      fi
    done < "$STAGE/removed"
    if [ "$any" = 1 ] && [ "$PRUNE" != 1 ]; then echo "(run again with --prune to delete them, or delete them yourself)"; fi
  fi

  # ---- 6. what to do next, only when needed ------------------------------------------------------------------
  local NEXT=()
  grep -Eq '^/package(-lock)?\.json$' "$STAGE/applied" && NEXT+=("npm install              (package.json changed)")
  grep -Eq '^/(src/|tsconfig|vitest\.config|eslint\.config)' "$STAGE/applied" && NEXT+=("npm run build            (source changed)")
  grep -Eq '^/tests/' "$STAGE/applied" && NEXT+=("npm test                 (tests changed)")
  grep -Eq '^/\.env\.example$' "$STAGE/applied" && NEXT+=("compare .env.example with your environment variables (new settings may have been added)")
  grep -Eq '^/(src/|package\.json|scripts/)' "$STAGE/applied" && NEXT+=("restart the app          (npm start)")
  if [ "${#NEXT[@]}" -gt 0 ]; then
    echo
    echo "Next:"
    local n
    for n in "${NEXT[@]}"; do echo "  $n"; done
  fi
  echo "Target folder: $TARGET"
}

main "$@"; exit $?
