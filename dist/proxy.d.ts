import * as http from 'http';
import { ProxyRuntimeContext } from './config';
/** Resolve a model/alias to the real upstream model, then return that model's
 *  real context window. Used by /models to advertise the true window so clients
 *  (AmbiCrew) can calibrate their compact threshold instead of guessing. */
export declare function resolveModelContextWindow(modelId: string, upstreamsByIdMap: Map<string, any>, defaultUpstream: any, modelRoutesMap?: Map<string, any>): number;
/** Tokens removed by a context trim = estimate before − estimate after,
 *  clamped to zero. Surfaced to the client via x-crew-trimmed-tokens (梯度 2). */
export declare function computeTrimmedTokens(estimated: number, estimatedAfter: number): number;
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
/** Provider-side transient failure where retrying the SAME key makes sense
 *  and cooling down would only amplify a momentary blip:
 *    529 / 503 — overload (GLM "访问量过大" code 1305, Anthropic overloaded_error)
 *    502 / 504 — gateway error / upstream timeout, almost always transient
 *  500 is intentionally excluded (often a persistent request-side fault), as
 *  are 4xx (client errors — retrying won't help). These MUST NOT cool down the
 *  key: for overload every key sees the same condition, and for gateway errors
 *  freezing the pool extends a sub-second blip into a 30s outage. */
export declare function isTransientServerError(status: number, errText: string): boolean;
/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date) → ms. */
export declare function parseRetryAfterMs(val: string | null): number | null;
export declare function createProxyServer(ctx: ProxyRuntimeContext): http.Server;
export {};
