import * as http from 'http';
import { ProxyRuntimeContext } from './config';
export declare function createAnthropicErrorBody(message: string, type: string): object;
export declare function formatSSEEvent(event: string, data: unknown): string;
export declare function fetchUpstream(url: string, init: RequestInit, timeoutMs?: number): Promise<Response>;
interface UpstreamErrorInfo {
    /** Most informative identifier: undici/node code (ECONNRESET, UND_ERR_*) or
     *  error name; null if nothing is available. */
    code: string | null;
    message: string;
    /** Serialized `cause` if present — nested undici errors carry the real
     *  reason here, not in .message. Truncated to keep logs bounded. */
    cause: string | null;
    /** Single-line summary used in the 502 body and the usage-log error field. */
    summary: string;
}
/** Extract the useful signal from a fetch/abort error. undici network errors
 *  put the reason in `.code` (ECONNRESET, ETIMEDOUT, UND_ERR_*) or nested
 *  `.cause`, NOT in `.message` — which is exactly why the old code surfaced
 *  "Upstream request failed: unknown". */
export declare function formatFetchError(err: any): UpstreamErrorInfo;
export declare function createProxyServer(ctx: ProxyRuntimeContext): http.Server;
export {};
