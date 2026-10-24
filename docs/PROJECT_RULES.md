# Workspace Mgr — Project Rules

Workspace Mgr is the backend/middleware between the Orion dashboard and OpenShift
Dev Spaces. It creates, lists, starts, stops and deletes DevWorkspaces for a user,
creates the user's project (namespace) when it does not exist, and records every
action to Postgres for the Dev Spaces dashboard.

These rules are binding for every change. If a rule must be broken, say why in the PR.

## 1. Architecture

1. **Layers, strictly top-down:** `routers` → `controllers` → `services` → `infra`/`factories` → `types`/`utils`.
   A lower layer never imports from a higher one.
2. **`controllers`** only parses/validates input, calls one service method, and maps the result or
   error to a response. No Kubernetes, SQL or business rules in routes.
3. **`services`** own business rules (limits, ordering of steps, naming, metrics events).
   They depend on **ports** (interfaces), never on concrete clients.
4. **`infra`** holds the concrete adapters (Kubernetes, Postgres, devfile registry, email).
   Every adapter implements a port declared in `src/infra/ports.ts`.
5. **`factories`** are pure functions (devfile → DevWorkspace, log records). No I/O.
6. **One composition root** (`src/container.ts`) wires adapters into services. Nothing else
   calls `new` on an adapter. Tests build the container with fakes.
7. No module-level side effects (no connecting to a DB, reading files, or reading `process.env`
   at import time). Startup config is read in `src/config/env.ts` and passed in; administrator runtime updates rebuild services.

## 2. Language and style

1. TypeScript `strict: true`, ESM (`"module": "NodeNext"`). Local imports end in `.js`.
2. No `any` except at a third-party boundary, and then it is narrowed immediately.
   **No `// @ts-ignore`.** Use `// @ts-expect-error` with a reason if truly unavoidable.
3. Prefer `async/await`. No `.then().catch()` chains.
4. Functions are small and single-purpose. A service method that needs a comment block to
   explain its steps should be split.
5. Names: `camelCase` values, `PascalCase` types/classes, feature-matched `*Router.ts` / `*Controller.ts` filenames for HTTP modules; `kebab-case.ts` for other modules
   that export functions, `PascalCase.ts` for files whose main export is a class.
6. Comments explain _why_, not _what_. No commented-out code, no TODO without an issue id.
7. `eslint` and `prettier` must pass with zero warnings.

## 3. Errors

1. Throw typed errors from `src/utils/errors.ts` (`AppError` subclasses). Each carries an HTTP
   status and a stable `code`.
2. Never swallow an error silently. Either handle it, record it, or rethrow it.
   The only intentional swallow is the metrics recorder (rule 6.2), and it logs.
3. Kubernetes/axios errors are translated to `AppError` at the adapter boundary
   (`src/utils/k8s-errors.ts`). Callers never inspect `err.body.code`.
4. Error responses always have the shape `{ "error": string, "message": string, "code": string }`.
   Never return a stack trace or upstream response body to the client.

## 4. Security

1. `SECRET_KEY` is **required**; the process refuses to start without it. No fallback secret.
2. Tokens: `Authorization: Bearer <jwt>` only. Verify with the explicit algorithm `HS256`.
3. Admin credential comparison is constant-time (`crypto.timingSafeEqual`).
4. Every `:soeid` and `:id` path parameter is validated against an allow-list pattern before it
   is used in a namespace name, label selector or Kubernetes path.
5. A caller may only act on their own `:soeid` unless the token has the `admin` role.
6. Never log tokens, passwords, PAT values, or full request bodies. PAT values are masked
   (`ghp_ab…xyz`) everywhere except the Secret itself.
7. Secrets for Kubernetes and Postgres come from the environment / mounted files, never from
   source or from git.
8. All SQL is parameterised. No string-built queries.
9. Kubernetes access uses the pod's service account with the minimum RBAC in
   `kustomize.server/base/sa.yaml`; do not widen it without review.

## 5. Kubernetes behaviour

1. Operations are idempotent: "create or replace" for quotas, roles, bindings, ConfigMaps.
2. Workspace namespaces are found by **label + annotation**, not by listing the whole cluster.
   Deployment namespaces are created through OpenShift's `ProjectRequest`, which may not apply our labels, so
   they are found by their deterministic name (`<soeid>-devspaces-deploy-<csiid>`).
3. A workspace id is `metadata.name`; it is unique inside a user's namespaces.
4. Poll loops have a hard timeout and an interval, are injectable (clock/sleep) for tests, and
   fail with a typed error. They never silently "fix" state by restarting workspaces.
5. Deleting something that is already gone is a success.

## 6. Metrics (Postgres)

1. Every user-visible action (create/delete/start/stop of workspace; create/delete of project;
   PAT/gitconfig changes) records one row to `metrics."devspaces-metrics"`, success **or** failure.
2. Recording is best-effort: a database failure is logged and must never fail or delay the
   user's action beyond a short timeout.
3. The row shape is defined once (`MetricsRecord`). The metrics table **already exists** and is owned by the
   database team: the service never issues DDL (no `CREATE`, `ALTER`, `DROP`) and ships no migrations. It only
   `INSERT`s, plus read-only `SELECT`s of the table's column list so it can write into an older table that lacks
   some of our columns. A test asserts this. The table SQL under `tests/helpers/` is a test fixture only.
4. Postgres is configured only through the existing variables (`POSTGRES_DATABASE`, `_HOSTNAME`, `_PASSWORD`,
   `_PORT`, `_USER`, `_DATABASE_TABLENAME`) and `NODE_ENV`, which picks the CA file (dev/uat/prod) as before.
5. Timestamps are written as UTC wall-clock text (`2026-01-02 03:04:05.678`), as the original service did. The
   CST format is for logs and emails only.

## 7. Testing

1. Three layers, all required for a feature:
   - **Unit** (`tests/unit`): one module, all collaborators faked, no network, no timers
     (use fake clock). Fast (< 5 s total).
   - **Integration** (`tests/integration`): real HTTP routes + real services + real SQL
     (`pg-mem`) + in-memory Kubernetes + a local fake devfile registry. Verifies wiring.
   - **End to end** (`tests/e2e`): a real listening server, driven only over HTTP
     (`fetch`) through whole user journeys (login → create → start → stop → delete), then
     asserting the Kubernetes state and metrics rows.
2. A bug fix starts with a failing test.
3. Tests do not depend on order, wall-clock time, or real cluster/DB access.
4. Coverage gate: ≥ 85 % lines and ≥ 80 % branches on `src/` (excluding `src/index.ts`).
5. No `.only`, no `.skip` committed.

## 8. API contract

1. **URI versioning, industry standard:** every API route is served under `/api/v1`
   (`/api/v1/login`, `/api/v1/catalog`, `/api/v1/:soeid/workspaces[/:id[/start|/stop]]`, ...).
   Path structure after the prefix is identical to the pre-versioning layout.
   Operational probes also use the version prefix.
2. Within a major version changes are additive only (new routes, new optional fields).
   A breaking change ships as `/api/v2` alongside `v1`; `v1` is then deprecated, never edited in place.
3. Unversioned routes return 404. There is no legacy router or compatibility switch.
4. Request bodies are validated with `zod`; unknown properties are rejected.
5. `409` for limit/conflict, `404` unknown resource, `400` invalid input, `401/403` auth,
   `502` upstream (cluster/registry) failure, `500` everything else.

## 9. Operations

1. `/api/v1/healthz` (liveness) never touches dependencies. `/api/v1/readyz` checks Kubernetes API and
   Postgres reachability.
2. Logs are one entry per event with `requestId`, `soeid`, `event`. Terminal format (`LOG_FORMAT=pretty`, the default) is readable and coloured: errors red, warnings orange, successes green, everything else white; `LOG_FORMAT=json` gives structured JSON lines. Use `logger.success` for something that worked, `warn` for a problem the caller or the setup caused, `error` for a failure on our side.
3. Graceful shutdown on `SIGTERM`: stop accepting, drain, close the DB pool.
4. Startup config uses environment variables documented in `.env.example`. Administrator runtime settings are process-local; see `API.md`.
5. Container runs as non-root, read-only root filesystem compatible.

## 10. Git and review

1. Small, focused commits; imperative subject line.
2. CI order: `typecheck` → `lint` → `test:unit` → `test:integration` → `test:e2e` → `build`.
3. A PR is mergeable only when the [CHECKLIST](./CHECKLIST.md) items for its scope are ticked.
