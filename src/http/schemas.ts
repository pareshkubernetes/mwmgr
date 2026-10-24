import { z } from 'zod';
import { ValidationError } from '../utils/errors.js';
import type { EditorKey } from '../types.js';

const identifier = /^[A-Za-z0-9._-]+$/;

const csiid = z
  .union([z.string(), z.number()], { error: 'csiid is required and must be numeric' })
  .transform((v) => String(v))
  .pipe(z.string().regex(/^\d{1,10}$/, 'csiid must be numeric'));

export const loginSchema = z.strictObject({ username: z.string().min(1), password: z.string().min(1) });

const editorKeys: Record<string, EditorKey> = {
  'che-code': 'vscode',
  'che-idea': 'intellij',
  'che-goland': 'goland',
  vscode: 'vscode',
  intellij: 'intellij',
  goland: 'goland',
};
const editorType = z.enum(['che-code', 'che-idea', 'che-goland', 'vscode', 'intellij', 'goland']);
const optionalText = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) => (value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value),
    schema.optional(),
  );
const branch = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, 'invalid branch name');

export const createWorkspaceSchema = z
  .strictObject({
    devworkspaceValue: z
      .string({ error: 'devworkspaceValue is required and must name a stack' })
      .min(1)
      .max(100)
      .regex(identifier, 'invalid stack name'),
    csiid,
    editorType: editorType.optional(),
    editor: z.enum(['vscode', 'intellij', 'goland']).optional(),
    stackVersion: z
      .string({ error: 'stackVersion is required and must be a string' })
      .min(1, 'stackVersion is required')
      .max(50)
      .regex(identifier, 'invalid stack version'),
    repositoryUrl: optionalText(z.url({ protocol: /^https$/ }).max(500)),
    repositoryCheckoutBranch: optionalText(branch),
    repositoryBranch: optionalText(branch),
  })
  .superRefine((body, context) => {
    if (!body.editorType && !body.editor)
      context.addIssue({
        code: 'custom',
        path: ['editorType'],
        message: 'editorType is required (che-code, che-idea, or che-goland)',
      });
    if (body.editorType && body.editor && editorKeys[body.editorType] !== body.editor)
      context.addIssue({
        code: 'custom',
        path: ['editorType'],
        message: 'editorType and editor must identify the same editor',
      });
    if (
      body.repositoryCheckoutBranch &&
      body.repositoryBranch &&
      body.repositoryCheckoutBranch !== body.repositoryBranch
    )
      context.addIssue({
        code: 'custom',
        path: ['repositoryCheckoutBranch'],
        message: 'Conflicting repository branch values',
      });
  })
  .transform(({ editorType, editor, repositoryCheckoutBranch, repositoryBranch, ...body }) => ({
    ...body,
    editor: editorKeys[editorType ?? editor ?? ''] as EditorKey,
    repositoryBranch: repositoryCheckoutBranch ?? repositoryBranch,
  }));

export const csiidQuerySchema = z.object({ csiid });
export const csiidBodySchema = z.strictObject({ csiid });
export const patBodySchema = z.strictObject({ csiid, token: z.string().min(1).max(200) });
export const gitConfigBodySchema = z.strictObject({ csiid, content: z.string().min(1) });

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const message = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new ValidationError(
      message,
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    );
  }
  return result.data;
}
