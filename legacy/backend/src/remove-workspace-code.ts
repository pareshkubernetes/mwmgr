const fetch = require('node-fetch');

const OPENSHIFT_API_URL = 'https://your-openshift-api-url.com';
const TOKEN = 'YOUR_OPENSHIFT_BEARER_TOKEN';
const namespace = 'your-namespace';
const workspaceName = 'your-workspace-name';

async function deleteDevWorkspace(namespace, workspaceName) {
  const url = `${OPENSHIFT_API_URL}/apis/workspace.devfile.io/v1alpha2/namespaces/${namespace}/devworkspaces/${workspaceName}?gracePeriodSeconds=0&propagationPolicy=Foreground`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to delete workspace: ${response.status} - ${errorBody}`);
  }

  const result = await response.json();
  console.log('Workspace deletion initiated successfully:', result);
}

(async () => {
  try {
    await deleteDevWorkspace(namespace, workspaceName);
    console.log('Deletion request sent successfully.');
  } catch (error) {
    console.error('Error during workspace deletion:', error);
  }
})();
