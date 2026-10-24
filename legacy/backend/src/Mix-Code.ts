import axios from 'axios';

async function fetchData() {
  try {
    const response = await axios.get('https://your-api-endpoint.com');
    console.log(response.data);
  } catch (error: unknown) {
    let message = 'Unknown Error';

    if (axios.isAxiosError(error)) {
      message =
        (error.response?.data && typeof error.response.data === 'object' && 'message' in error.response.data
          ? String((error.response.data as any).message)
          : error.message) || 'Axios Error Occurred';
    } else if (error instanceof Error) {
      message = error.message;
    }

    console.error('Error:', message);
  }
}

export class TestCode {
    async waitForPVCBound(namespace: string, pvcName: string): Promise<void> {
        const maxAttempts = 20;
        const intervalMs = 2000; // 2 seconds
        let attempt = 0;
    
        while (attempt < maxAttempts) {
            attempt++;
    
            try {
                const pvcResponse = await this.httpClient.get(
                    `/api/v1/namespaces/${namespace}/persistentvolumeclaims/${pvcName}`
                );
    
                const pvc = pvcResponse.data;
                const pvcPhase = pvc.status.phase;
    
                if (pvcPhase === 'Bound') {
                    console.log(`PVC "${pvcName}" is Bound.`);
                    return;
                }
    
                if (pvc.metadata.deletionTimestamp) {
                    // PVC is terminating, wait until it's deleted
                    console.log(`Attempt ${attempt}: PVC "${pvcName}" is Terminating. Waiting for deletion...`);
                } else {
                    console.log(`Attempt ${attempt}: PVC "${pvcName}" status is "${pvcPhase}". Waiting...`);
                }
            } catch (checkError: any) {
                if (checkError.response?.status === 404) {
                    console.log(`Attempt ${attempt}: PVC "${pvcName}" not found. Possibly deleted.`);
                    // PVC is deleted, now wait for it to be recreated and bound
                    return this.waitForPVCRecreationAndBound(namespace, pvcName, maxAttempts, intervalMs);
                } else {
                    console.error('Unexpected error checking PVC:', checkError);
                    throw checkError;
                }
            }
    
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
    
        throw new Error(`PVC "${pvcName}" did not become Bound or delete within ${(maxAttempts * intervalMs) / 1000} seconds. Please check.`);
    }
    
    private async waitForPVCRecreationAndBound(namespace: string, pvcName: string, maxAttempts: number, intervalMs: number): Promise<void> {
        let attempt = 0;
    
        while (attempt < maxAttempts) {
            attempt++;
    
            try {
                const pvcResponse = await this.httpClient.get(
                    `/api/v1/namespaces/${namespace}/persistentvolumeclaims/${pvcName}`
                );
    
                const pvc = pvcResponse.data;
                const pvcPhase = pvc.status.phase;
    
                if (pvcPhase === 'Bound') {
                    console.log(`PVC "${pvcName}" is Bound after recreation.`);
                    return;
                } else {
                    console.log(`Attempt ${attempt}: Newly created PVC "${pvcName}" status is "${pvcPhase}". Waiting...`);
                }
            } catch (checkError: any) {
                if (checkError.response?.status === 404) {
                    console.log(`Attempt ${attempt}: PVC "${pvcName}" still not found. Waiting...`);
                } else {
         
    
    
    
}
