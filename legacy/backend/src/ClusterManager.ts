// @ts-ignore
import axios, { AxiosInstance } from 'axios';
// @ts-ignore
import { KubeConfig, CustomObjectsApi, CoreV1Api, RbacAuthorizationV1Api, V1RoleBinding, V1Role } from '@kubernetes/client-node';
// @ts-ignore
import * as fs from 'fs';
// @ts-ignore
import path from 'path';
// @ts-ignore
import yaml from 'js-yaml';
import { clientQuery } from './dbUtils';

export class ClusterManager {
    private readonly apiUrl: string;
    private readonly httpClient: AxiosInstance;
    private readonly devwGroup: string;
    private readonly devwVersion: string;
    private readonly devwKind: string;
    private readonly devwPural: string;
    private readonly devwTemplateGroup: string;
    private readonly devwTemplateVersion: string;
    private readonly devwTemplateKind: string;
    private readonly devwTemplatePural: string;
    private readonly nsUserAnnotKey: string;
    private readonly nsUserLabelKey: string;
    private readonly nsUserLabelVal: string;
    private readonly kubeApi: CoreV1Api;
    private readonly kubeApiCustom: CustomObjectsApi;
    private readonly kubeApiRbac: RbacAuthorizationV1Api;
    private readonly templateProject: any;
    private readonly templateRole: any;

    constructor(clusterApiUrl: string) {
        this.apiUrl = clusterApiUrl;
        this.devwGroup = 'workspace.devfile.io';
        this.devwVersion = 'v1alpha2';
        this.devwKind = 'DevWorkspace';
        this.devwPural = 'devworkspaces';
        this.devwTemplateGroup = 'workspace.devfile.io';
        this.devwTemplateVersion = 'v1alpha2';
        this.devwTemplateKind = 'DevWorkspaceTemplate';
        this.devwTemplatePural = 'devworkspacetemplates';
        this.nsUserAnnotKey = 'che.eclipse.org/username';
        this.nsUserLabelKey = 'app.kubernetes.io/component';
        this.nsUserLabelVal = 'workspaces-namespace';

        const timestampInsert = '2024-11-20 14:42:47.186';
        const csiid = '177398';
        const eventtype = 'CREATE';
        const resourcename = 'Java-Workspace';
        const status = {failed: false, error: null};
        const queryText = `INSERT INTO devspaces-metrics (timestamp, csiid, eventtype, resourcename, resourcetype, status) VALUES ($1, $2, $3, $4, $5) `



        await clientQuery(queryText,[timestampInsert, csiid, eventtype] )
        // Setup kube api
        // @ts-ignore
        const kubeConfigPath: any = process.argv[2];
        const kubeConfig = new KubeConfig();
        let token: string = '';
        if (kubeConfigPath) {
            kubeConfig.loadFromFile(kubeConfigPath);
            const user: any = kubeConfig.getCurrentUser();
            token = user?.token;
        } else {
            kubeConfig.loadFromDefault();
            const tokenFilePath = kubeConfig.getCurrentUser()!.authProvider!.config!.tokenFile;
            token = fs.readFileSync(tokenFilePath, 'utf8');
        }
        this.kubeApi = kubeConfig.makeApiClient(CoreV1Api);
        this.kubeApiCustom = kubeConfig.makeApiClient(CustomObjectsApi);
        this.kubeApiRbac = kubeConfig.makeApiClient(RbacAuthorizationV1Api);

        // Setup http client
        // console.log(`SA token used: ${token}`);
        this.httpClient = axios.create({
            baseURL: this.apiUrl,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        // Load configs
        // @ts-ignore
        this.templateProject = this.loadConfig(path.join(__dirname, '..', 'config', 'user-namespace.yaml'));
        // @ts-ignore
        this.templateRole = this.loadConfig(path.join(__dirname, '..', 'config', 'user-role-default.yaml'));
        // console.log('Api url: ', this.apiUrl);
    }

    
    async createUserNs(userid: string, csiid: string): Promise<any> {
        try {
            let jsonData = this.replacePlaceholder(this.templateProject, 'USERID', userid);
            jsonData = this.replacePlaceholder(jsonData, 'CSIID', csiid);
            const { body: ns } = await this.kubeApi.createNamespace(jsonData);
            await this.grantAccessToProject(userid, jsonData.metadata.name);
            return ns;
        } catch (error) {
            throw error;
        }
    }
    private loadConfig(path: string): any {
        try {
            const yamlData = fs.readFileSync(path, 'utf8');
            const jsonData = yaml.load(yamlData);
            return jsonData;
        } catch (error) {
            console.error('Error loading YAML:', error);
            throw error;
        }
    }

    private replacePlaceholder(jsonData: any, placeholder: string, newValue: string): any {
        let tempData: any = JSON.parse(JSON.stringify(jsonData));
        const replaceRecursively = (obj: any): void => {
            for (const key in obj) {
                if (typeof obj[key] === 'object') {
                    replaceRecursively(obj[key]);
                } else if (typeof obj[key] === 'string') {
                    obj[key] = obj[key].replace(new RegExp(`${placeholder}`, 'g'), newValue);
                }
            }
        };
        replaceRecursively(tempData);
        return tempData;
    }

    private getCsiidFromNs(ns: string): string {
        try {
            const lastDashIndex = ns.lastIndexOf('-');
            return ns.substring(lastDashIndex + 1);
        } catch (error) {
            console.error('Cannot get csiid from namespace:', error);
            throw error;
        }
    }

    async getUserNsAllV1(userid: string): Promise<any[]> {
        try {
            const res = await this.httpClient.get(`/api/v1/namespaces?labelSelector=${encodeURIComponent(this.nsUserLabelKey)}`);
            const projects = res.data.items.filter((project: any) => {
                const annotations = project.metadata.annotations;
                return annotations && annotations[this.nsUserAnnotKey] === userid;
            });
            return projects;
        } catch (error) {
            console.error('Error finding all user projects:', error);
            throw error;
        }
    }

    async getUserNsAll(userid: string): Promise<any[]> {
        try {
            const { body: namespaceList } = await this.kubeApi.listNamespace();
            const userNamespaces: any[] = [];
            namespaceList.items.forEach((namespace: any) => {
                const labels = namespace.metadata?.labels;
                const annotations = namespace.metadata?.annotations;

                if (labels?.[this.nsUserLabelKey] == this.nsUserLabelVal && annotations?.[this.nsUserAnnotKey] === userid) {
                    userNamespaces.push(namespace);
                }
            });

            return userNamespaces;
        } catch (error) {
            console.error(`Error finding all user projects for ${userid}`);
            throw error;
        }
    }

    async getUserNs(userid: string, csiid: string): Promise<any> {
        try {
            const filterName = `${userid}-devspaces-${csiid}`;
            const { body: namespaceList } = await this.kubeApi.listNamespace();
            const namespace = namespaceList.items.find((namespace: any) => namespace.metadata?.name === filterName);
            // TODO: check if namespace has the devspaces label and annotation in case it is created manually.
            if (namespace) {
                return namespace;
            }
            console.log(`${filterName} not found, creating...`);
            return await this.createUserNs(userid, csiid);
        } catch (error) {
            throw error;
        }
    }

    async getUserNsV1(userid: string, csiid: string): Promise<any> {
        try {
            const ns = `${userid}-devspaces-${csiid}`;
            const res = await this.httpClient.get(`/api/v1/namespaces?labelSelector=${encodeURIComponent(this.nsUserLabelKey)}`);
            const projects = res.data.items.find((project: any) => {
                const annotations = project.metadata.annotations;
                const projectName = project.metadata.name;
                // nsUserAnnot = che.eclipse.org/username
                // console.log('Checking project:', projectName);
                // console.log('if (annotations?.[this.nsUserAnnot]):', annotations?.[this.nsUserAnnot]);
                // console.log('if (annotations?.[this.nsUserAnnot] === userid):', annotations?.[this.nsUserAnnot] === userid);
                // console.log('if (projectName === ns):', projectName === ns);
                return (annotations?.[this.nsUserAnnotKey] === userid) && (projectName === ns);
            });
            if (projects == null || projects.length == 0) {
                console.log(`${ns} not found, creating ...`);
                return await this.createUserNs(userid, csiid);
            } else {
                return projects;
            }
        } catch (error) {
            console.error('Error finding user project by userid:', error);
            throw error;
        }
    }

    async createUserNs(userid: string, csiid: string): Promise<any> {
        try {
            let jsonData = this.replacePlaceholder(this.templateProject, 'USERID', userid);
            jsonData = this.replacePlaceholder(jsonData, 'CSIID', csiid);
            const { body: ns } = await this.kubeApi.createNamespace(jsonData);
            await this.grantAccessToProject(userid, jsonData.metadata.name);
            return ns;
        } catch (error) {
            throw error;
        }
    }

    async createUserNsV1(userid: string, csiid: string): Promise<any> {
        try {
            let jsonData = this.replacePlaceholder(this.templateProject, 'USERID', userid);
            jsonData = this.replacePlaceholder(this.templateProject, 'CSIID', csiid);
            const res = await this.httpClient.post('/api/v1/namespaces', jsonData);
            await this.grantAccessToProject(userid, jsonData.metadata.name);
            return res.data;
        } catch (error) {
            console.error('Error creating project from YAML:', error);
            throw error;
        }
    }

    async grantAccessToProject(userid: string, project: any): Promise<any> {
        try {
            if (typeof project !== 'string' || project === '') {
                throw new Error('Project must be a non-empty string');
            }
            const role: V1Role = this.templateRole as V1Role;
            role.metadata!.namespace = project;
            const roleBinding: V1RoleBinding = {
                metadata: {
                    name: `devspaces-project-access-${userid}`,
                    namespace: project,
                    labels: {
                        'app.kubernetes.io/component': 'devspaces-workspace-management',
                    },
                },
                subjects: [{ kind: 'User', name: userid, namespace: project }],
                roleRef: {
                    kind: 'Role',
                    name: role.metadata?.name || 'devspaces-user-role',
                    apiGroup: 'rbac.authorization.k8s.io',
                },
            };
            await this.kubeApiRbac.createNamespacedRole(project, role);
            await this.kubeApiRbac.createNamespacedRoleBinding(project, roleBinding);
        } catch (error) {
            console.error('Error creating RoleBinding:', error);
            throw error;
        }
    }

    async getActiveDevworkspaceCount(userid: string): Promise<number> {
        return await this.listDevworkspaces(userid)
            .then((devworkspaces: any[]) => {
                return devworkspaces.filter((dw: any) => dw.status.phase === 'Running' || dw.status.phase === 'Starting' || dw.status.phase === 'Stopping' || !dw.status.phase).length;
            })
            .catch((error) => {
                console.error('Error getting running devworkspace count:', error);
                throw error;
            });
    }
    
    async listDevworkspaces(userid: string): Promise<any[]> {
        let devworkspaces: any[] = [];
        return await this.getUserNsAll(userid)
            .then((nss: any[]) => {
                return Promise.all(nss.map(async (ns: any) => {
                    const res = await this.httpClient.get(`/apis/${this.devwGroup}/${this.devwVersion}/namespaces/${ns.metadata.name}/${this.devwPural}`);
                    res.data.items.map((dw: any) => devworkspaces.push(dw));
                }));
            })
            .then(() => devworkspaces)
            .catch((error) => {
                console.error('Error listing devworkspaces', error);
                throw error;
            });
    }

    async getIsDevworkspaceConfigValid(userid: string, config: any): Promise<boolean> {
        // get user devworkspaces
        return this.listDevworkspaces(userid)
            .then((devworkspaces: any) => {
                return !devworkspaces.some((dws: any) => dws.metadata.name === config.metadata.name)
            })
            .catch((error) => {
                console.error('Error validating devworkspace config:', error);
                throw error;
            });
    }

    async listDevworkspaceTemplates(userid: string): Promise<any> {
        let devworkspaceTemplates: any[] = [];
        return await this.getUserNsAll(userid)
            .then(async (nss: any[]) => {
                await Promise.all(
                    nss.map(async (ns: any) => {
                        const res = await this.httpClient.get(`/apis/${this.devwTemplateGroup}/${this.devwTemplateVersion}/namespaces/${ns.metadata.name}/${this.devwTemplatePural}`);
                        res.data.items.map((dwt: any) => devworkspaceTemplates.push(dwt));
                    }));
            })
            .catch((error) => {
                console.error('Error listing devworkspaceTemplates', error);
                throw error;
            });
    }

    async getDevworkspacetemplate(userid: string, name: string): Promise<any> {
        return await this.listDevworkspaceTemplates(userid)
            .then((devworkspaceTemplates: any[]) => {
                return devworkspaceTemplates.find((dwt: any) => dwt.metadata.name === name);
            })
            .catch((error) => {
                console.error('Error fetching devworkspace template:', error);
                throw error;
            });
    }

    async getDevworkspace(userid: string, name: string): Promise<any> {
        return await this.listDevworkspaces(userid)
            .then((devworkspaces: any[]) => {
                const devworkspace = devworkspaces.find((dw: any) => dw.metadata.name === name);
                return devworkspace === undefined ? null : devworkspace;
            })
            .catch((error) => {
                console.error('Error fetching devworkspace:', error);
                throw error;
            });
    }

    async getDevworkspacePhase(userid: string, name: string): Promise<any> {
        return await this.getDevworkspace(userid, name)
            .then((dw: any) => dw.status.phase)
            .catch((error) => {
                console.error('Error fetching devworkspace phase:', error);
                throw error;
            });
    }

    async getDevworkspaceLink(userid: string, name: string): Promise<string> {
        return await this.getDevworkspace(userid, name)
            .then((dw: any) => {
                return dw.status.mainUrl;
            })
            .catch((error) => {
                console.error('Error fetching devworkspace link:', error);
                throw error;
            });
    }

    async createDevworkspace(userid: string, csiid: string, configs: any): Promise<any[]> {
        try {
            const ns = await this.getUserNs(userid, csiid);
            let resources: any[] = [];
            const resDevworkspaceTemplate = await this.httpClient.post(`/apis/${this.devwTemplateGroup}/${this.devwTemplateVersion}/namespaces/${ns.metadata.name}/${this.devwTemplatePural}`, configs[0]);
            const resDevworkspace = await this.httpClient.post(`/apis/${this.devwGroup}/${this.devwVersion}/namespaces/${ns.metadata.name}/${this.devwPural}`, configs[1]);
            resources[0] = resDevworkspaceTemplate.data;
            resources[1] = resDevworkspace.data;
            //PUSH
            return resources;
        } catch(error) {
            console.error('Error creating devworkspace:', error);
            // PUSH
            throw error;
        }
    }

    async deleteDevworkspace(userid: string, name: string): Promise<any> {
        console.log(`Deleting devworkspace: ${name} ...`);
        const dw = await this.getDevworkspace(userid, name);
        try {
            await this.httpClient.delete(`/apis/${this.devwGroup}/${this.devwVersion}/namespaces/${dw.metadata.namespace}/${this.devwPural}/${name}`);
            await Promise.all(
                dw.spec.contributions.map(async (template: any) => {
                    const templateName = template.kubernetes.name;
                    console.log(`Deleting devworkspace template: ${templateName} ...`);
                    await this.httpClient.delete(`/apis/${this.devwTemplateGroup}/${this.devwTemplateVersion}/namespaces/${dw.metadata.namespace}/${this.devwTemplatePural}/${templateName}`)
                        .catch((error: any) => {
                            if (error?.response?.status == 404) {
                                // devworkspaceTemplate is already removed at this point.
                                // Might need to do additional cleanup.
                                console.log(`${templateName} is already removed. Skipping`);
                            }
                            else {
                                throw error;
                            }
                        })
                }));
        } catch (error) {
            console.error('Error deleting devworkspace and templates:', error);
            throw error;
        }
    }

    // Patching only possible via the kube library...
    async startDevworkspace(userid: string, name: string, started: boolean): Promise<any> {
        const messageVerb = started ? 'Starting' : 'Stopping';
        console.log(`${messageVerb} devworkspace: ${name} ...`);
        const dw = await this.getDevworkspace(userid, name);
        const patchData = [
            { 'op': 'replace', 'path': '/spec/started', 'value': started }
        ];
        const options = { 'headers': { 'Content-type': 'application/json-patch+json' } }
        return await this.kubeApiCustom.patchNamespacedCustomObject(this.devwGroup, this.devwVersion, dw.metadata.namespace, this.devwPural, name, patchData, undefined, undefined, undefined, options)
            .then((res: any) => {
                return res.body;
            })
            .catch((error: any) => {
                console.error(`Error ${messageVerb} devworkspace:`, error);
                throw error;
            });
    }

    async waitDevworkspaceRunningState(userid: string, name: string): Promise<any> {
        const timeoutMs = 120000;
        const desiredPhase = 'Running';
        const failedPhase = 'Failed';
        let restartCount = 5;
        let currentRestartCount = 0;
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            try {
                const devworkpsace = await this.getDevworkspace(userid, name);
                if (devworkpsace.status.phase === desiredPhase) {
                    // After running state it can still change to failed state
                    await new Promise(resolve => setTimeout(resolve, 4000));
                    if (devworkpsace.status.phase === desiredPhase) {
                        return devworkpsace;
                    }
                } else if (devworkpsace.status.phase === failedPhase && currentRestartCount <= restartCount) {
                    restartCount += 1;
                    console.log('Workspace in failed phase, restarting:', devworkpsace.metadata.name);
                    await this.startDevworkspace(userid, name, true);
                }
                console.log(`Waiting for workspace Running state: ${name} ...`);
            } catch (error) {
                console.error('Error waiting for devworkspace Running phase:', error);
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 4000));
        }
        console.error('Timeout reached while waiting for devworkspace to start.');
        throw new DevworkspaceStartTimeout('Timeout reached while waiting for devworkspace to start.');
    }

    async waitDevworkspaceStoppedState(userid: string, name: string): Promise<any> {
        const timeoutMs = 120000;
        const desiredPhase = 'Stopped';
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            try {
                const devworkpsace = await this.getDevworkspace(userid, name);
                if (devworkpsace.status.phase === desiredPhase) {
                    return devworkpsace;
                } else {
                    console.log('Quick restart to solve error state for workspace:', name);
                    await this.startDevworkspace(userid, name, true);
                    await this.startDevworkspace(userid, name, false);
                }
                console.log(`Waiting for workspace Stopped state: ${name} ...`);
            } catch (error) {
                console.error('Error waiting for devworkspace Stopped phase:', error);
            }
            await new Promise(resolve => setTimeout(resolve, 4000));
        }
        console.error('Timeout reached while waiting for devworkspace to start.');
        throw new DevworkspaceStopTimeout('Timeout reached while waiting for devworkspace to start.');
    }

    async waitDevworkspaceDelete(userid: string, name: string): Promise<void> {
        try {
            const pollInterval = 2000;
            while (await this.getDevworkspace(userid, name) !== null) {
                console.log(`Waiting for devworkspace deletion: ${name} ...`);
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
            console.log('Devworkspace deleted successfully:', name);
        } catch (error) {
            console.error('Error waiting for devworkspace deletion:', error);
            throw error;
        }
    }
}

export class DevworkspaceStartTimeout extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkspaceStartTimeout';
        Object.setPrototypeOf(this, DevworkspaceStartTimeout.prototype);
    }
}

export class DevworkspaceStopTimeout extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkspaceStopTimeout';
        Object.setPrototypeOf(this, DevworkspaceStopTimeout.prototype);
    }
}

export class DevworkspaceNotFound extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkspaceStopTimeout';
        Object.setPrototypeOf(this, DevworkspaceStopTimeout.prototype);
    }
}

