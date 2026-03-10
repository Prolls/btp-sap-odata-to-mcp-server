import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { HttpDestination } from '@sap-cloud-sdk/connectivity';
import { DestinationService } from './destination-service.js';
import { Logger } from '../utils/logger.js';
import { Config } from '../utils/config.js';


export class SAPClient {
    private discoveryDestination: HttpDestination | null = null;
    private config: Config;
    private currentUserToken?: string;

    constructor(
        private destinationService: DestinationService,
        private logger: Logger
    ) {
        this.config = new Config();
    }

    /**
     * Set the current user's JWT token for subsequent operations
     */
    setUserToken(token?: string) {
        this.currentUserToken = token;
        this.logger.debug(`User token ${token ? 'set' : 'cleared'} for SAP client`);
    }

    /**
     * Get destination for discovery operations (technical user)
     */
    async getDiscoveryDestination(): Promise<HttpDestination> {
        if (!this.discoveryDestination) {
            this.discoveryDestination = await this.destinationService.getDiscoveryDestination();
        }
        return this.discoveryDestination;
    }

    /**
     * Get destination for execution operations (with JWT if available)
     */
    async getExecutionDestination(): Promise<HttpDestination> {
        return await this.destinationService.getExecutionDestination(this.currentUserToken);
    }

    /**
     * Legacy method - defaults to discovery destination
     */
    async getDestination(): Promise<HttpDestination> {
        return this.getDiscoveryDestination();
    }

    async executeRequest(options: {
        url: string;
        method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
        data?: unknown;
        headers?: Record<string, string>;
        isDiscovery?: boolean;
    }) {
        // Use discovery destination for metadata/discovery calls, execution destination for data operations
        const destination = options.isDiscovery
            ? await this.getDiscoveryDestination()
            : await this.getExecutionDestination();

        const requestOptions = {
            method: options.method,
            url: options.url,
            data: options.data,
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...options.headers
            }
        };

        try {
            this.logger.debug(`Executing ${options.method} request to ${options.url}`);

            if (!destination.url) {
                throw new Error('Destination URL is not configured');
            }

            const response = await executeHttpRequest(destination as HttpDestination, requestOptions);

            this.logger.debug(`Request completed successfully`);
            return response;

        } catch (error) {
            this.logger.error(`Request failed:`, error);
            throw this.handleError(error);
        }
    }

    async countEntitySet(servicePath: string, entitySet: string, filter?: string): Promise<number> {
        let url = `${servicePath}${entitySet}/$count`;
        if (filter) {
            url += `?$filter=${encodeURIComponent(filter)}`;
        }
        const response = await this.executeRequest({
            method: 'GET',
            url,
            isDiscovery: false,
            headers: { 'Accept': 'text/plain' }
        });
        const count = parseInt(String(response.data), 10);
        if (isNaN(count)) {
            throw new Error(`Unexpected /$count response: ${JSON.stringify(response.data)}`);
        }
        return count;
    }

    async readEntitySet(servicePath: string, entitySet: string, queryOptions?: {
        $filter?: string;
        $select?: string;
        $expand?: string;
        $orderby?: string;
        $top?: number;
        $skip?: number;
    }, isDiscovery = false) {
        let url = `${servicePath}${entitySet}`;

        if (queryOptions) {
            const params = new URLSearchParams();
            Object.entries(queryOptions).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    params.set(key, String(value));
                }
            });

            if (params.toString()) {
                url += `?${params.toString()}`;
            }
        }

        return this.executeRequest({
            method: 'GET',
            url,
            isDiscovery
        });
    }

    async readEntity(servicePath: string, entitySet: string, key: string, isDiscovery = false) {
        const url = `${servicePath}${entitySet}(${key})`;

        return this.executeRequest({
            method: 'GET',
            url,
            isDiscovery
        });
    }

    async createEntity(servicePath: string, entitySet: string, data: unknown) {
        const url = `${servicePath}${entitySet}`;
        const { token, cookies } = await this.fetchCsrfToken(await this.getExecutionDestination(), servicePath);

        return this.executeRequest({
            method: 'POST',
            url,
            data,
            headers: { 'X-CSRF-Token': token, ...(cookies ? { 'Cookie': cookies } : {}) }
        });
    }

    async updateEntity(servicePath: string, entitySet: string, key: string, data: unknown) {
        const url = `${servicePath}${entitySet}(${key})`;
        const { token, cookies } = await this.fetchCsrfToken(await this.getExecutionDestination(), servicePath);

        return this.executeRequest({
            method: 'PATCH',
            url,
            data,
            headers: { 'X-CSRF-Token': token, ...(cookies ? { 'Cookie': cookies } : {}) }
        });
    }

    async deleteEntity(servicePath: string, entitySet: string, key: string) {
        const url = `${servicePath}${entitySet}(${key})`;
        const { token, cookies } = await this.fetchCsrfToken(await this.getExecutionDestination(), servicePath);

        return this.executeRequest({
            method: 'DELETE',
            url,
            headers: { 'X-CSRF-Token': token, ...(cookies ? { 'Cookie': cookies } : {}) }
        });
    }

    private async fetchCsrfToken(destination: HttpDestination, servicePath: string): Promise<{ token: string; cookies: string }> {
        try {
            this.logger.debug(`Fetching CSRF token from ${servicePath}`);
            const response = await executeHttpRequest(destination as HttpDestination, {
                method: 'GET',
                url: servicePath,
                timeout: 30000,
                headers: {
                    'X-CSRF-Token': 'Fetch',
                    'Accept': 'application/json'
                }
            });
            const token = response.headers['x-csrf-token'];
            this.logger.debug(`CSRF token response: status=${response.status}, token=${token ? token.toString().substring(0, 20) + '...' : 'MISSING'}`);
            if (!token) {
                throw new Error('No X-CSRF-Token returned by the server');
            }
            // Capture session cookies so the PATCH uses the same SAP session as the token fetch
            const setCookie = response.headers['set-cookie'];
            const cookies = Array.isArray(setCookie)
                ? setCookie.map((c: string) => c.split(';')[0]).join('; ')
                : (setCookie ? (setCookie as string).split(';')[0] : '');
            this.logger.debug(`Session cookies captured: ${cookies ? cookies.substring(0, 60) + '...' : 'NONE'}`);
            return { token: token as string, cookies };
        } catch (error) {
            this.logger.error('Failed to fetch CSRF token:', error);
            throw error;
        }
    }

    private handleError(error: unknown): Error {
        if (
            typeof error === 'object' &&
            error !== null &&
            'rootCause' in error &&
            (error as { rootCause?: { response?: { status: number; data?: { error?: { message?: string } }; statusText?: string } } }).rootCause?.response
        ) {
            const response = (error as { rootCause: { response: { status: number; data?: { error?: { message?: string } }; statusText?: string } } }).rootCause.response;
            return new Error(`SAP API Error ${response.status}: ${response.data?.error?.message || response.statusText}`);
        }
        return error instanceof Error ? error : new Error(String(error));
    }
}
