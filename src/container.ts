import type { AppConfig } from './config/env.js';
import { MetricsRepository, NoopMetricsStore, createPgPool } from './infra/db/MetricsRepository.js';
import { DevfileRegistryClient, createRegistryHttp } from './infra/devreg/DevfileRegistryClient.js';
import { EmailNotifier, NoopNotifier } from './infra/email/EmailNotifier.js';
import { GraphqlUserDirectory, NullUserDirectory } from './infra/email/GraphqlUserDirectory.js';
import { KubeClient, createKubeConfig } from './infra/kube/KubeClient.js';
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
import { SupportService } from './services/SupportService.js';
import type { Logger } from './utils/logger.js';

export interface Dependencies {
  kube: KubeGateway;
  /** Cluster for build/deploy projects when it is a different one; defaults to `kube`. */
  deployKube?: KubeGateway;
  metrics: MetricsStore;
  registry: DevfileRegistry;
  notifier: Notifier;
  clock?: Clock;
}

export interface Container {
  reconfigure(config: AppConfig): void;
  config: AppConfig;
  logger: Logger;
  kube: KubeGateway;
  /** Same object as `kube` unless a separate deploy cluster is configured. */
  deployKube: KubeGateway;
  metrics: MetricsStore;
  registry: DevfileRegistry;
  recorder: MetricsRecorder;
  namespaces: NamespaceService;
  workspaces: WorkspaceService;
  pats: PatService;
  gitConfig: GitConfigService;
  deployments: DeploymentNamespaceService;
  support: SupportService;
}

/** Wire services to production adapters or test doubles. */
export function buildContainer(
  config: AppConfig,
  logger: Logger,
  deps: Dependencies,
  refresh?: (config: AppConfig) => Dependencies,
): Container {
  const clock = deps.clock ?? systemClock;
  const recorder = new MetricsRecorder(deps.metrics, clock, logger);
  const namespaces = new NamespaceService(
    deps.kube,
    recorder,
    { workspaceProxyUrl: config.devreg.workspaceProxyUrl, emailDomain: config.notification.emailDomain },
    logger,
  );
  const deployments = new DeploymentNamespaceService(
    deps.deployKube ?? deps.kube,
    recorder,
    deps.notifier,
    config.cluster.deployProjectRequester,
    logger,
  );
  const container: Container = {
    reconfigure(next) {
      const nextDependencies = refresh ? refresh(next) : deps;
      const reconfigure = container.reconfigure;
      Object.assign(container, buildContainer(next, logger, nextDependencies, refresh), { reconfigure });
    },
    config,
    logger,
    kube: deps.kube,
    deployKube: deps.deployKube ?? deps.kube,
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
    deployments,
    support: new SupportService({
      kube: deps.kube,
      deployKube: deps.deployKube ?? deps.kube,
      namespaces,
      deployments,
      logger,
    }),
  };
  return container;
}

/** Real adapters for a running pod. */
export function createProductionDependencies(config: AppConfig, logger: Logger): Dependencies {
  const directory = config.notification.userDirectoryUrl
    ? new GraphqlUserDirectory(config.notification.userDirectoryUrl, logger)
    : new NullUserDirectory();
  const { cluster } = config;
  const skipTlsVerify = !cluster.tlsRejectUnauthorized;
  const separateDeploy = cluster.deployApiUrl !== cluster.apiUrl;
  return {
    kube: new KubeClient(
      createKubeConfig({
        apiUrl: cluster.apiUrl,
        token: cluster.token,
        kubeconfigPath: cluster.kubeconfigPath,
        skipTlsVerify,
      }),
    ),
    deployKube: separateDeploy
      ? new KubeClient(
          createKubeConfig({
            apiUrl: cluster.deployApiUrl,
            token: cluster.deployToken,
            kubeconfigPath: cluster.kubeconfigPath,
            skipTlsVerify,
          }),
        )
      : undefined,
    metrics: config.postgres.enabled
      ? new MetricsRepository(createPgPool(config.postgres, logger), config.postgres.table, logger)
      : new NoopMetricsStore(),
    registry: new DevfileRegistryClient(createRegistryHttp(config.devreg.url)),
    notifier: config.notification.url
      ? new EmailNotifier(config.notification, config.cluster.deployApiUrl, directory, logger)
      : new NoopNotifier(),
  };
}
