import { z } from 'zod';
import { BadRequestError } from '../utils/errors.js';

const identifier = /^[A-Za-z0-9._-]+$/;

const csiid = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^\d{1,10}$/, 'csiid must be numeric'));

export const loginSchema = z.strictObject({ username: z.string().min(1), password: z.string().min(1) });

export const createWorkspaceSchema = z.strictObject({
  devworkspaceValue: z.string().min(1).max(100).regex(identifier, 'invalid stack name'),
  csiid,
  editor: z.enum(['vscode', 'intellij', 'goland']).default('vscode'),
  stackVersion: z.string().max(50).regex(identifier, 'invalid stack version').optional(),
  repositoryUrl: z
    .url({ protocol: /^https$/ })
    .max(500)
    .optional(),
  repositoryBranch: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9._/-]+$/, 'invalid branch name')
    .optional(),
});

export const csiidQuerySchema = z.object({ csiid });
export const csiidBodySchema = z.strictObject({ csiid });
export const patBodySchema = z.strictObject({ csiid, token: z.string().min(1).max(200) });
export const gitConfigBodySchema = z.strictObject({ csiid, content: z.string().min(1) });

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new BadRequestError(message, 'VALIDATION_ERROR');
  }
  return result.data;
}
