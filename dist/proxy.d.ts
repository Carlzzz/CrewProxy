import * as http from 'http';
import { ProxyRuntimeContext } from './config';
export declare function createAnthropicErrorBody(message: string, type: string): object;
export declare function formatSSEEvent(event: string, data: unknown): string;
export declare function createProxyServer(ctx: ProxyRuntimeContext): http.Server;
