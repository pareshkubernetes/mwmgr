import { z } from 'zod';
import { queryLogs } from '../config/daily-logs.js';
import { asyncHandler } from '../http/errors.js';
import { parse } from '../http/schemas.js';

const query = z.strictObject({
  days: z.coerce.number().int().min(1).max(31).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  search: z.string().max(200).optional(),
  requestId: z.string().max(64).optional(),
  soeid: z.string().max(64).optional(),
  format: z.enum(['json', 'text']).default('json'),
});
export function logController() {
  return {
    list: asyncHandler(async (req, res) => {
      const options = parse(query, req.query);
      const result = await queryLogs(options);
      if (options.format === 'text') {
        res
          .type('text')
          .send(
            [
              `Application logs | ${result.from} to ${result.to} | ${result.entries.length} entries | truncated: ${result.truncated}`,
              ...result.entries.map(
                ({ time, level, event, ...fields }) =>
                  `${String(time)} ${String(level).toUpperCase()} ${String(event)} ${JSON.stringify(fields)}`,
              ),
            ].join('\n'),
          );
      } else res.json(result);
    }),
  };
}
