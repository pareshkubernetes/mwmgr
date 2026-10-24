type Fields = Record<string, unknown>;

export function logCategory(event: string): string {
  const category = event.split('.')[0] ?? 'application';
  return (
    (
      {
        workspace: 'Workspace',
        namespace: 'Namespace',
        deployment_namespace: 'Deployment',
        server: 'Server',
        request: 'HTTP',
        email: 'Email',
        configuration: 'Configuration',
        support: 'Support',
        metrics: 'Metrics',
      } as Record<string, string>
    )[category] ?? 'Application'
  );
}

/** Sentences for operators; structured logs retain the event names and individual fields. */
export function logMessage(event: string, fields: Fields): string | undefined {
  const user = typeof fields.soeid === 'string' ? ` for user '${fields.soeid}'` : '';
  const namespace = typeof fields.namespace === 'string' ? ` in namespace '${fields.namespace}'` : '';
  const workspace = String(fields.workspace ?? '');
  switch (event) {
    case 'workspace.creating':
      return `Creating a workspace from stack '${String(fields.stack)}'${user}${namespace}.`;
    case 'workspace.created':
      return `Created workspace resource '${workspace}'${user}${namespace}${fields.version && fields.editor ? ` (version: ${String(fields.version)}, editor: ${String(fields.editor)})` : ''}. Dev Spaces will now start it.`;
    case 'workspace.starting':
      return `Starting workspace '${workspace}'${user}${namespace}.`;
    case 'workspace.stopping':
      return `Stopping workspace '${workspace}'${user}${namespace}.`;
    case 'workspace.deleting':
      return `Deleting workspace '${workspace}'${user}${namespace}.`;
    case 'workspace.started':
      return `Requested startup of workspace '${workspace}'${user}${namespace}.`;
    case 'workspace.stopped':
      return `Requested stop of workspace '${workspace}'${user}${namespace}.`;
    case 'workspace.deleted':
      return `Successfully deleted workspace '${workspace}'${user}${namespace}.`;
    case 'workspace.duration':
      return `Workspace '${workspace}' ran for ${String(fields.duration)}${user}.`;
    case 'workspace.repository_skipped':
      return `No repository URL supplied${user}; creating the workspace from its stack without adding a repository.`;
    case 'workspace.repository_default_branch':
      return `No checkout branch supplied${user}; the repository will use its default branch.`;
    case 'namespace.creating':
      return `Creating namespace '${String(fields.namespace)}'${user}.`;
    case 'namespace.resource_applied':
      return `Applied ${String(fields.kind)} '${String(fields.name)}'${namespace}.`;
    case 'deployment_namespace.created':
      return `Successfully created deployment namespace '${String(fields.namespace)}'${user}.`;
    case 'support.resources_applied':
      return `Successfully reconciled ${String(fields.target)} resources${user}${namespace}.`;
    case 'configuration.updated':
      return `Updated runtime settings${Array.isArray(fields.keys) ? `: ${fields.keys.join(', ')}` : ''}.`;
    case 'server.listening':
      return `Workspace Manager is listening on port ${String(fields.port)}.`;
    case 'server.shutdown':
      return `Shutting down Workspace Manager${fields.signal ? ` after receiving ${String(fields.signal)}` : ''}.`;
    case 'email.sent':
      return `Successfully sent notification '${String(fields.subject)}'${user}.`;
    case 'email.skipped':
      return `Skipped notification '${String(fields.subject)}': ${String(fields.reason)}.`;
    case 'request': {
      if (
        typeof fields.method !== 'string' ||
        typeof fields.path !== 'string' ||
        typeof fields.status !== 'number'
      )
        return undefined;
      const duration = typeof fields.ms === 'number' ? `, ${fields.ms} ms` : '';
      const requestId = typeof fields.requestId === 'string' ? ` Request ID: ${fields.requestId}.` : '';
      return `${fields.method} ${fields.path} completed successfully${user} (HTTP ${fields.status}${duration}).${requestId}`;
    }
    default:
      return undefined;
  }
}
