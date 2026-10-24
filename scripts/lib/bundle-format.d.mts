export const BUNDLE_MAGIC: string;
export function sha256(buffer: Buffer): string;
export function isTextBuffer(buffer: Buffer): boolean;
export function isSafeRelativePath(p: unknown): boolean;
export function isExcluded(relPath: string): boolean;
export function createBundle(
  files: { path: string; content: Buffer }[],
  options?: { generatedAt?: Date; note?: string },
): string;
export function parseBundle(text: string): {
  meta: { generated: string; files: number; note?: string; lineEndingsRepaired?: boolean };
  files: { path: string; enc: string; content: Buffer; sha256: string }[];
};
