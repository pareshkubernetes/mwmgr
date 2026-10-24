export class Wrapper {

    async startUserWorkspace(soeid: string, workspaceid: string): Promise<workspace> {
    try {
        const devworkspace = await this.cluster.startDevworkspace(soeid, workspaceid, true);

    } catch (error) {
        throw new Error(`Wrapper: startUserWorkspace(): failed: ${error}`)
    }
}
}