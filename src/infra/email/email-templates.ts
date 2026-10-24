export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface ClusterLinks {
  apiUrl: string;
  consoleUrl: string;
  tokenUrl: string;
}

/** `https://api.<domain>:6443` → console and OAuth token URLs on `apps.<domain>`. */
export function clusterLinks(apiUrl: string): ClusterLinks {
  try {
    const url = new URL(apiUrl);
    const apps = url.hostname.replace(/^api\./, 'apps.');
    return {
      apiUrl,
      consoleUrl: `https://console-openshift-console.${apps}/`,
      tokenUrl: `https://oauth-openshift.${apps}/oauth/token/request`,
    };
  } catch {
    return { apiUrl, consoleUrl: '', tokenUrl: '' };
  }
}

const STYLE = `body{margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Arial,sans-serif;color:#323130}
.wrapper{max-width:700px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden}
.header{background:#0f4c81;color:#fff;padding:24px;text-align:center}.header h1{margin:0;font-size:26px}
.content{padding:28px}code,pre{font-family:Consolas,'Courier New',monospace;background:#1e1e1e;color:#fff;padding:4px 8px;border-radius:4px}
.footer{background:#0f4c81;color:#fff;padding:16px;text-align:center;font-size:.9em}a{color:#0078d4}`;

function layout(title: string, heading: string, body: string, recipient: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><div class="wrapper"><div class="header"><h1>${escapeHtml(heading)}</h1></div><div class="content">${body}</div><div class="footer"><p>&copy; ${new Date().getFullYear()} DevSpaces Team.</p><p>This email was sent to ${escapeHtml(recipient)}.</p><p>Confidentiality Notice: this email and any attachments are confidential and intended solely for the addressee.</p></div></div></body></html>`;
}

const greeting = (firstName: string | undefined, soeid: string): string =>
  escapeHtml(firstName ?? `User ${soeid.toUpperCase()}`);

const links = (c: ClusterLinks): string =>
  `<ul><li>Cluster API endpoint: <a href="${escapeHtml(c.apiUrl)}">${escapeHtml(c.apiUrl)}</a></li>` +
  (c.consoleUrl
    ? `<li>OpenShift console: <a href="${escapeHtml(c.consoleUrl)}">${escapeHtml(c.consoleUrl)}</a></li>`
    : '') +
  (c.tokenUrl
    ? `<li>Generate a login token: <a href="${escapeHtml(c.tokenUrl)}">${escapeHtml(c.tokenUrl)}</a></li>`
    : '') +
  `</ul>`;

export function newNamespaceEmailBody(args: {
  firstName?: string;
  soeid: string;
  namespace: string;
  cluster: ClusterLinks;
  recipient: string;
}): string {
  return layout(
    'DevSpaces Deployment Project Ready',
    'DevSpaces Deployment Project Ready',
    `<p>Dear ${greeting(args.firstName, args.soeid)},</p>
<p>Your OpenShift deployment project <code>${escapeHtml(args.namespace)}</code> has been created and is ready for use.</p>
<h2>Quick start</h2>
<ol><li>Generate a login token and run the <code>oc login</code> command it gives you.</li>
<li>Select your project: <pre>oc project ${escapeHtml(args.namespace)}</pre></li>
<li>Build and deploy your application inside this project.</li></ol>
${links(args.cluster)}
<p>Newly provisioned resources may take several minutes to become fully available.</p>`,
    args.recipient,
  );
}

export function existingNamespaceEmailBody(args: {
  firstName?: string;
  soeid: string;
  newNamespace: string;
  existingNamespace: string;
  cluster: ClusterLinks;
  recipient: string;
}): string {
  return layout(
    'Important: Your DevSpaces Deployment Project Already Exists',
    'DevSpaces Notification',
    `<p>Dear ${greeting(args.firstName, args.soeid)},</p>
<p>You recently asked for a new deployment project (<code>${escapeHtml(args.newNamespace)}</code>), but you already have one,
so no new project was created.</p>
<h2>Connect to your existing deployment project</h2>
<pre>oc project ${escapeHtml(args.existingNamespace)}</pre>
${links(args.cluster)}`,
    args.recipient,
  );
}

export function deletedNamespacesEmailBody(args: {
  firstName?: string;
  soeid: string;
  namespaces: string[];
  recipient: string;
}): string {
  const items = args.namespaces.map((ns) => `<li><code>${escapeHtml(ns)}</code></li>`).join('');
  return layout(
    'Confirmation: DevSpaces Deployment Project(s) Deleted',
    'DevSpaces Notification',
    `<p>Dear ${greeting(args.firstName, args.soeid)},</p>
<p>The following DevSpaces deployment project(s) associated with your user id have been deleted:</p>
<ul>${items}</ul>
<p>Thank you for managing your resources.</p>`,
    args.recipient,
  );
}
