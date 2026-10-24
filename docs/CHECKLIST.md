# Workspace Mgr — Build & Review Checklist

Tick items as they are completed. Items map to [PROJECT_RULES.md](./PROJECT_RULES.md).

## A. Before coding

- [x] Read legacy code, prompts and screenshots; list behaviours to keep (see README "Intentionally not ported")
- [x] Write rules and this checklist
- [x] Move legacy code to `legacy/` (kept for reference, excluded from build)
- [x] Decide defaults for unknowns and document them (README "Assumptions")

## B. Scaffolding

- [x] `package.json` with scripts: `build`, `start`, `dev`, `typecheck`, `lint`, `test`, `test:unit`, `test:integration`, `test:e2e`, `test:coverage`, `bundle`, `restore`
- [x] `tsconfig.json` (strict, NodeNext), `tsconfig.build.json`
- [x] ESLint + Prettier configs
- [x] Vitest config with three projects and coverage thresholds
- [x] `.env.example`, `.gitignore`, `.dockerignore`, `Dockerfile`
- [x] No migrations: the existing Postgres table is used as-is (the test fixture SQL lives in `tests/helpers/`)

## C. Core

- [x] Env config validated with zod; missing `SECRET_KEY` fails fast
- [x] Typed errors + HTTP mapping
- [x] Kubernetes/axios error translation
- [x] Timestamp (CST) helper, duration formatter, CPU/memory parsers
- [x] Logger (JSON, redaction)
- [x] Kubernetes constants (quotas, limit ranges, network policies, roles)

## D. Infrastructure (ports + adapters)

- [x] Ports: `KubeGateway`, `MetricsStore`, `DevfileRegistry`, `Notifier`, `UserDirectory`
- [x] `KubeClient` (real, `@kubernetes/client-node`)
- [x] `MetricsRepository` (pg Pool, parameterised INSERT only, adapts to the existing table's columns, never DDL)
- [x] Postgres TLS exactly as the original: CA file chosen by `NODE_ENV` (dev/uat/prod), hostname check relaxed only in development
- [x] `DevfileRegistryClient` (catalog + devfile by name/version)
- [x] `EmailNotifier` + templates (new namespace / existing namespace / deleted), HTML-escaped
- [x] `GraphqlUserDirectory` (first name lookup, falls back to soeid)

## E. Domain logic

- [x] Devfile updater per editor (VS Code, IntelliJ, GoLand)
- [x] DevWorkspace factory
- [x] Resource summary (cpu / memory / storage) from components
- [x] `NamespaceService` (find-or-create, RBAC, quota, limit range, network policies, proxy/git ConfigMaps)
- [x] `WorkspaceService` (list, get, create, start, stop, delete, count limits)
- [x] `PatService` (list, view masked, create, update, delete)
- [x] `GitConfigService` (view, create/update, delete)
- [x] `DeploymentNamespaceService` (check/create/delete deploy projects)
- [x] `MetricsRecorder` (best-effort)

## F. HTTP

- [x] JWT auth middleware (Bearer, HS256, role + soeid ownership)
- [x] URI versioning: everything under `/api/v1`; unversioned paths only as deprecated aliases
- [x] `/api/v1/login`, `/api/v1/catalog`, `/healthz`, `/readyz`
- [x] `/api/v1/:soeid/projects`
- [x] `/api/v1/:soeid/workspaces` CRUD + start/stop
- [x] `/api/v1/:soeid/pats`, `/api/v1/:soeid/gitconfig`, `/api/v1/:soeid/deployment-projects`
- [x] zod validation, central error handler, request id, graceful shutdown

## G. Tests

- [x] Unit tests for every module in C, D (adapters with fakes), E, F
- [x] Integration tests: routes + services + pg-mem + in-memory kube + HTTP registry
- [x] E2E tests: login → create → list → start → stop → delete; PAT; gitconfig; deploy project; limits; auth failures; legacy-path client
- [x] Coverage thresholds met
- [x] `pack.sh` / `unpack.sh`: whole app in one text file and back, checksummed, never overwrites without `--force`
- [x] Bash scripts tested (exact round trip incl. CRLF/binary/empty files, tamper, truncation, CRLF repair, path traversal, private-key guard)
- [x] Bundle/restore scripts tested (format, CLI round trip, git changed-files mode, safety)

## H. Release

- [x] `npm run typecheck && npm run lint` clean
- [x] `npm run test:coverage` green
- [x] `npm run build` produces `dist/`
- [x] Built server smoke-tested as a process (start, login, 502 on unreachable registry, refuses to start without `SECRET_KEY`)
- [ ] Docker image builds (`docker build .`) — _not run here; Docker not used_
- [x] README documents routes, env vars, assumptions, open questions
- [ ] Helm/kustomize reviewed against port (3050) and env vars — _chart has no Deployment template; left unchanged_
- [ ] Smoke test against a real dev OpenShift cluster, Postgres and devfile registry — _not possible from here_
