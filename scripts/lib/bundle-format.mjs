// Shared by scripts/bundle.mjs and scripts/restore.mjs.
//
// A bundle is ONE text file holding many files, designed to survive copy/paste, email and chat tools:
//
//   WORKSPACE-MGR-BUNDLE v1
//   generated: 2026-01-01T00:00:00.000Z
//   boundary: 3f9c...            <- random per bundle, so file contents can never collide with markers
//   files: 2
//   (blank line)
//   @@@ FILE <boundary> {"path":"src/a.ts","enc":"utf8","bytes":12,"sha256":"..."} @@@
//   ...file content exactly as it is...
//   @@@ END <boundary> @@@
//
// Text files are stored verbatim (CRLF, BOM and a missing final newline are all preserved).
// Binary files are stored as base64. Every file carries its byte length and SHA-256, verified on restore.

import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export const BUNDLE_MAGIC = 'WORKSPACE-MGR-BUNDLE v1';

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.idea', '.vscode']);
const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** True when the bytes are valid UTF-8 without NUL bytes (so they can be stored verbatim as text). */
export function isTextBuffer(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/** Relative, forward-slash, no `..`, no drive letters: a path that cannot escape the target directory. */
export function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p) || p.includes('\\')) return false;
  const normalized = path.posix.normalize(p);
  return normalized === p && !normalized.split('/').includes('..') && normalized !== '.';
}

/** Files that must never be bundled: dependencies, build output, VCS data, secrets, previous bundles. */
export function isExcluded(relPath) {
  const parts = relPath.split('/');
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
  const name = parts[parts.length - 1] ?? '';
  if (EXCLUDED_FILES.has(name)) return true;
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true; // secrets
  if (name.endsWith('.bundle.txt') || name.endsWith('.log')) return true;
  return false;
}

/**
 * @param {{ path: string, content: Buffer }[]} files
 * @param {{ generatedAt?: Date, note?: string }} [options]
 */
export function createBundle(files, options = {}) {
  const seen = new Set();
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) throw new Error(`Refusing to bundle unsafe path: ${file.path}`);
    if (seen.has(file.path)) throw new Error(`Duplicate path in bundle: ${file.path}`);
    seen.add(file.path);
  }

  const encoded = files.map((file) => {
    const text = isTextBuffer(file.content);
    return {
      ...file,
      enc: text ? 'utf8' : 'base64',
      body: text ? file.content.toString('utf8') : wrap64(file.content),
    };
  });

  let boundary;
  do {
    boundary = randomBytes(12).toString('hex');
  } while (encoded.some((f) => f.body.includes(boundary)));

  const lines = [
    BUNDLE_MAGIC,
    `generated: ${(options.generatedAt ?? new Date()).toISOString()}`,
    `boundary: ${boundary}`,
    `files: ${files.length}`,
  ];
  if (options.note) lines.push(`note: ${options.note.replace(/[\r\n]+/g, ' ')}`);
  let out = `${lines.join('\n')}\n\n`;

  for (const f of encoded) {
    const meta = JSON.stringify({
      path: f.path,
      enc: f.enc,
      bytes: f.content.length,
      sha256: sha256(f.content),
    });
    out += `@@@ FILE ${boundary} ${meta} @@@\n${f.body}\n@@@ END ${boundary} @@@\n`;
  }
  return out;
}

const wrap64 = (buffer) => buffer.toString('base64').replace(/(.{76})/g, '$1\n');

/**
 * @param {string} text
 * @returns {{ meta: { generated: string, files: number, note?: string, lineEndingsRepaired?: boolean }, files: { path: string, enc: string, content: Buffer, sha256: string }[] }}
 */
export function parseBundle(text) {
  try {
    return parseStrict(text);
  } catch (error) {
    // An editor, e-mail client or `git autocrlf` may have turned every LF into CRLF. Undo that, but only
    // accept the result if every file still matches its recorded size and SHA-256; otherwise report the
    // original problem, never a silently altered file.
    if (text.includes('\r\n')) {
      try {
        const repaired = parseStrict(text.replace(/\r\n/g, '\n'));
        repaired.meta.lineEndingsRepaired = true;
        return repaired;
      } catch (repairError) {
        throw new Error(
          `${error.message}. The line endings look converted to CRLF, and converting them back did not ` +
            `restore every file exactly (${repairError.message}). Re-copy the bundle without line-ending conversion.`,
          { cause: repairError },
        );
      }
    }
    throw error;
  }
}

function parseStrict(text) {
  if (!text.startsWith(`${BUNDLE_MAGIC}\n`) && !text.startsWith(`${BUNDLE_MAGIC}\r\n`)) {
    throw new Error(`Not a workspace-mgr bundle (first line must be "${BUNDLE_MAGIC}")`);
  }
  const header = text.slice(0, text.search(/\r?\n\r?\n/) + 1 || undefined);
  const field = (name) => new RegExp(`^${name}: (.*?)\\r?$`, 'm').exec(header)?.[1];
  const boundary = field('boundary');
  const declared = Number(field('files'));
  if (!boundary || !/^[0-9a-f]{16,}$/.test(boundary)) throw new Error('Bundle header has no valid boundary');
  if (!Number.isInteger(declared) || declared < 0) throw new Error('Bundle header has no valid file count');

  const startMarker = `@@@ FILE ${boundary} `;
  const endMarker = `\n@@@ END ${boundary} @@@`;
  const files = [];
  const seen = new Set();
  let cursor = header.length;

  for (;;) {
    const start = text.indexOf(startMarker, cursor);
    if (start === -1) break;
    const headerEnd = text.indexOf(' @@@\n', start);
    if (headerEnd === -1) throw new Error(`Malformed file header at offset ${start}`);

    let meta;
    try {
      meta = JSON.parse(text.slice(start + startMarker.length, headerEnd));
    } catch {
      throw new Error(`Unreadable file header at offset ${start}`);
    }
    const bodyStart = headerEnd + ' @@@\n'.length;
    const bodyEnd = text.indexOf(endMarker, bodyStart - 1);
    if (bodyEnd === -1 || bodyEnd < bodyStart - 1) throw new Error(`Missing end marker for ${meta.path}`);

    if (!isSafeRelativePath(meta.path))
      throw new Error(`Unsafe path in bundle: ${JSON.stringify(meta.path)}`);
    if (seen.has(meta.path)) throw new Error(`Duplicate path in bundle: ${meta.path}`);
    seen.add(meta.path);

    const body = text.slice(bodyStart, Math.max(bodyStart, bodyEnd));
    let content;
    if (meta.enc === 'utf8') content = Buffer.from(body, 'utf8');
    else if (meta.enc === 'base64') content = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    else throw new Error(`Unknown encoding "${meta.enc}" for ${meta.path}`);

    if (content.length !== meta.bytes) {
      throw new Error(
        `Size mismatch for ${meta.path}: expected ${meta.bytes} bytes, found ${content.length}`,
      );
    }
    if (sha256(content) !== meta.sha256) throw new Error(`Checksum mismatch for ${meta.path}`);

    files.push({ path: meta.path, enc: meta.enc, content, sha256: meta.sha256 });
    cursor = bodyEnd + endMarker.length;
  }

  if (files.length !== declared) {
    throw new Error(`Bundle declares ${declared} files but contains ${files.length} (truncated or edited?)`);
  }
  return { meta: { generated: field('generated') ?? '', files: declared, note: field('note') }, files };
}
