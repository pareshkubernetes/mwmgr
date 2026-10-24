import type { Container } from '../container.js';
import {
  runtimeSettingsSchema,
  runtimeSettingsView,
  applyRuntimeSettings,
} from '../config/runtime-settings.js';
import { asyncHandler } from '../http/errors.js';
import { parse } from '../http/schemas.js';

export function configurationController(container: Container) {
  return {
    view: asyncHandler(async (_req, res) => {
      res.json({ settings: runtimeSettingsView(container.config), persistence: 'process-lifetime' });
    }),
    update: asyncHandler(async (req, res) => {
      const body = parse(runtimeSettingsSchema, req.body);
      container.reconfigure(applyRuntimeSettings(container.config, body));
      container.logger.info('configuration.updated', { keys: Object.keys(body) });
      res.json({ settings: runtimeSettingsView(container.config), persistence: 'process-lifetime' });
    }),
  };
}
