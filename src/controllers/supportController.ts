import { z } from 'zod';
import type { Container } from '../container.js';
import { asyncHandler } from '../http/errors.js';
import { parse } from '../http/schemas.js';

const resource = z
  .object({
    kind: z.enum(['Role', 'RoleBinding', 'ResourceQuota', 'LimitRange', 'ClusterRole', 'ClusterRoleBinding']),
    metadata: z
      .object({
        name: z
          .string()
          .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/)
          .max(253),
      })
      .strict(),
  })
  .passthrough();
const bodySchema = z.strictObject({
  soeid: z.string(),
  csiid: z.union([z.string(), z.number()]).transform(String),
  target: z.enum(['workspace', 'deployment']),
  resources: z.array(resource).min(1).max(20).optional(),
});

export function supportController(container: Container) {
  return {
    apply: asyncHandler(async (req, res) => {
      const body = parse(bodySchema, req.body);
      res.json(await container.support.apply(body));
    }),
  };
}
