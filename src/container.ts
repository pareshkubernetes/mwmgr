import type { AppConfig } from './config/env.js';
import { MetricsRepository, NoopMetricsStore, createPgPool } from './infra/db/MetricsRepository.js';
import { DevfileRegistryClient, createRegistryHttp } from './infra/devreg/DevfileRegistryClient.js';
import { EmailNotifier, NoopNotifier } from './infra/email/EmailNotifier.js';
import { GraphqlUserDirectory, NullUserDirectory } from './infra/email/GraphqlUserDirectory.js';
import { KubeClient, loadKubeConfig } from './infra/kube/KubeClient.js';
import {
  systemClock,
  type Clock,
  type DevfileRegistry,
  type KubeGateway,
  type MetricsStore,
  type Notifier,
} from './infra/ports.js';
import { DeploymentNamespaceService } from './services/DeploymentNamespaceService.js';
import { GitConfigService } from './services/GitConfigService.js';
import { MetricsRecorder } from './services/MetricsRecorder.js';
import { NamespaceService } from './services/NamespaceService.js';
import { PatService } from './services/PatService.js';
import { WorkspaceService } from './services/WorkspaceService.js';
import type { Logger } from './utils/logger.js';

export interface Dependencies {
  kube: KubeGateway;
  metrics: MetricsStore;
  registry: DevfileRegistry;
  notifier: Notifier;
  clock?: Clock;
}

export interface Container {
  config: AppConfig;
  logger: Logger;
  kube: KubeGateway;
  metrics: MetricsStore;
  registry: DevfileRegistry;
  recorder: MetricsRecorder;
  namespaces: NamespaceService;
  workspaces: WorkspaceService;
  pats: PatService;
  gitConfig: GitConfigService;
  deployments: DeploymentNamespaceService;
}

/** The single place where adapters are wired into services. Tests call this with fakes. */
export function buildContainer(config: AppConfig, logger: Logger, deps: Dependencies): Container {
  const clock = deps.clock ?? systemClock;
  const recorder = new MetricsRecorder(deps.metrics, clock, logger);
  const namespaces = new NamespaceService(
    deps.kube,
    recorder,
    { workspaceProxyUrl: config.devreg.workspaceProxyUrl, emailDomain: config.notification.emailDomain },
    logger,
  );
  return {
    config,
    logger,
    kube: deps.kube,
    metrics: deps.metrics,
    registry: deps.registry,
    recorder,
    namespaces,
    workspaces: new WorkspaceService(
      deps.kube,
      namespaces,
      deps.registry,
      recorder,
      {
        limits: config.limits,
        editors: config.devreg.editors,
        devSpacesServiceFqdn: config.cluster.devSpacesServiceFqdn,
      },
      clock,
      logger,
    ),
    pats: new PatService(deps.kube, namespaces, recorder, config.github),
    gitConfig: new GitConfigService(deps.kube, namespaces, recorder),
    deployments: new DeploymentNamespaceService(
      deps.kube,
      recorder,
      deps.notifier,
      config.cluster.deployProjectRequester,
      logger,
    ),
  };
}

/** Real adapters for a running pod. */
export function createProductionDependencies(config: AppConfig, logger: Logger): Dependencies {
  const directory = config.notification.userDirectoryUrl
    ? new GraphqlUserDirectory(config.notification.userDirectoryUrl, logger)
    : new NullUserDirectory();
  return {
    kube: new KubeClient(loadKubeConfig(config.cluster.kubeconfigPath)),
    metrics: config.postgres.enabled
      ? new MetricsRepository(createPgPool(config.postgres), config.postgres.table)
      : new NoopMetricsStore(),
    registry: new DevfileRegistryClient(createRegistryHttp(config.devreg.url)),
    notifier: config.notification.url
      ? new EmailNotifier(config.notification, config.cluster.apiUrl, directory, logger)
      : new NoopNotifier(),
  };
}
