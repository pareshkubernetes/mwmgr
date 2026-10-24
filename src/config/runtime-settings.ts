import { z } from 'zod';
import { deriveDevSpacesFqdn, type AppConfig } from './env.js';
import { BadRequestError } from '../utils/errors.js';

const url = z.url({ protocol: /^https?$/ }).max(2000);
export const runtimeSettingsSchema = z
  .strictObject({
    DEVREG_URL: url.optional(),
    NOTIFICATION_MAIL_URL: url.optional(),
    NOTIFICATION_EMAIL_USERNAME: z.string().max(200).optional(),
    NOTIFICATION_EMAIL_PASSWORD: z.string().max(4000).optional(),
    MAX_RUNNING_WORKSPACES: z.number().int().positive().optional(),
    MAX_TOTAL_WORKSPACES: z.number().int().positive().optional(),
    CLUSTER_API_URL: url.optional(),
    CLUSTER_TOKEN: z.string().min(1).max(20000).optional(),
    DEPLOY_CLUSTER_API_URL: url.optional(),
    DEPLOY_CLUSTER_TOKEN: z.string().min(1).max(20000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one setting is required');

export const runtimeSettingsView = (current: AppConfig) => ({
  DEVREG_URL: current.devreg.url,
  NOTIFICATION_MAIL_URL: current.notification.url,
  NOTIFICATION_EMAIL_USERNAME: current.notification.username,
  NOTIFICATION_EMAIL_PASSWORD: current.notification.password ? '[redacted]' : '',
  MAX_RUNNING_WORKSPACES: current.limits.maxRunning,
  MAX_TOTAL_WORKSPACES: current.limits.maxTotal,
  CLUSTER_API_URL: current.cluster.apiUrl,
  CLUSTER_TOKEN: current.cluster.token ? '[redacted]' : '',
  DEPLOY_CLUSTER_API_URL: current.cluster.deployApiUrl,
  DEPLOY_CLUSTER_TOKEN: current.cluster.deployToken ? '[redacted]' : '',
});

export function applyRuntimeSettings(
  current: AppConfig,
  body: z.infer<typeof runtimeSettingsSchema>,
): AppConfig {
  if (body.CLUSTER_API_URL && body.CLUSTER_API_URL !== current.cluster.apiUrl && !body.CLUSTER_TOKEN)
    throw new BadRequestError('Changing the cluster URL requires its token in the same request');
  if (
    body.DEPLOY_CLUSTER_API_URL &&
    body.DEPLOY_CLUSTER_API_URL !== current.cluster.deployApiUrl &&
    !body.DEPLOY_CLUSTER_TOKEN
  )
    throw new BadRequestError('Changing the deployment cluster URL requires its token in the same request');
  const config = structuredClone(current);
  if (body.DEVREG_URL !== undefined) config.devreg.url = body.DEVREG_URL;
  if (body.NOTIFICATION_MAIL_URL !== undefined) config.notification.url = body.NOTIFICATION_MAIL_URL;
  if (body.NOTIFICATION_EMAIL_USERNAME !== undefined)
    config.notification.username = body.NOTIFICATION_EMAIL_USERNAME;
  if (body.NOTIFICATION_EMAIL_PASSWORD !== undefined)
    config.notification.password = body.NOTIFICATION_EMAIL_PASSWORD;
  if (body.MAX_RUNNING_WORKSPACES !== undefined) config.limits.maxRunning = body.MAX_RUNNING_WORKSPACES;
  if (body.MAX_TOTAL_WORKSPACES !== undefined) config.limits.maxTotal = body.MAX_TOTAL_WORKSPACES;
  if (config.limits.maxRunning > config.limits.maxTotal)
    throw new BadRequestError('Maximum running workspaces cannot exceed maximum total workspaces');
  if (body.CLUSTER_API_URL !== undefined) {
    config.cluster.apiUrl = body.CLUSTER_API_URL;
    config.cluster.devSpacesServiceFqdn = deriveDevSpacesFqdn(body.CLUSTER_API_URL);
  }
  if (body.CLUSTER_TOKEN !== undefined) config.cluster.token = body.CLUSTER_TOKEN;
  if (body.DEPLOY_CLUSTER_API_URL !== undefined) config.cluster.deployApiUrl = body.DEPLOY_CLUSTER_API_URL;
  else if (current.cluster.deployApiUrl === current.cluster.apiUrl)
    config.cluster.deployApiUrl = config.cluster.apiUrl;
  if (body.DEPLOY_CLUSTER_TOKEN !== undefined) config.cluster.deployToken = body.DEPLOY_CLUSTER_TOKEN;
  if (
    config.cluster.deployApiUrl !== config.cluster.apiUrl &&
    !config.cluster.deployToken &&
    !config.cluster.kubeconfigPath
  )
    throw new BadRequestError('A separate deployment cluster requires a token or kubeconfig');
  return config;
}
