// @ts-ignore
import axios, { AxiosInstance } from 'axios';
// @ts-ignore
import yaml from 'js-yaml';
// @ts-ignore
import { randomBytes } from 'crypto';

export class DevregManager {
    private readonly devregUrl: string;
    private readonly httpClient: AxiosInstance;
    readonly editorVscode: string;
    readonly editorIntellij: string;
    
    constructor(devregUrl: string, editorVscode: string, editorIntellij: string) {
        this.devregUrl = devregUrl;
        this.editorVscode = editorVscode;
        this.editorIntellij = editorIntellij;
        this.httpClient = axios.create({
            baseURL: this.devregUrl,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });
    }

    async getCatalog(): Promise<any[]> {
        try {
            const res = await this.httpClient.get('devfiles');
            const catalog = res.data
            return catalog;
        } catch (error) {
            console.error('Error during fetching devfile registry catalog:', error);
            return [];
        }
    }

    // First element will be the DevworkspaceTemplate crd the second element Devworkspace crd
    convertConfigFromString(rawDocument: string): any[] {
        try {
            const yamlDocuments = rawDocument.split('---').map((doc: string) => doc.trim());
            const parsedDocuments: any[] = [];

            for (const document of yamlDocuments) {
                const parsedDocument = yaml.load(document);
                if (parsedDocuments) {
                    parsedDocuments.push(parsedDocument);
                }
            }
            return parsedDocuments;
        } catch (error) {
            console.error('Error parsing devworkspace configs:', error);
            throw error;
        }
    }

    async getDevworkspaceConfigs(devworkspaceValue: string, editor: string): Promise<any[]> {
        return await this.getCatalog()
            .then((catalog: any[]) => {
                // Find the right config the user chosed by devworkspaceValue
                // @ts-ignore
                const metaItem = catalog.find(obj => Object.values(obj.links.devWorkspaces).includes(devworkspaceValue))
                if (!metaItem || metaItem === undefined) throw new WorkspaceConfigNotFound('No such workspace config');
                return this.httpClient.get(`/${metaItem.links.devWorkspaces[editor]}`);
            })
            .then((res: any) => {
                const yamlContent = res.data;
                let jsonContents = this.convertConfigFromString(yamlContent);
                jsonContents = this.randomizeDevworkspaceName(jsonContents);
                return jsonContents;
            })
            .catch((error) => {
                if (error instanceof WorkspaceConfigNotFound) {
                    throw error;
                }
                console.error('Error during fetching devworkspace configs:', error);
                throw error;
            });
    }

    randomizeDevworkspaceName(configs: any): [] {
        const randomBytesBuffer = randomBytes(2);
        const randomHex = randomBytesBuffer.toString('hex');
        const randomGUID = randomHex.substring(0, 4);
        configs[0].metadata.name = `${configs[0].metadata.name}-${randomGUID}`;
        configs[1].metadata.name = `${configs[1].metadata.name}-${randomGUID}`;
        configs[1].spec.contributions[0].kubernetes.name = configs[0].metadata.name;
        return configs;
    }
}

export class WorkspaceConfigNotFound extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WorkspaceConfigNotFound';
        Object.setPrototypeOf(this, WorkspaceConfigNotFound.prototype);
    }
}