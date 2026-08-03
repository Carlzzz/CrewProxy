export interface CodePlanCredential {
    id: string;
    apiKey: string;
    model?: string;
    weight: number;
    enabled: boolean;
}
export interface UpstreamConfig {
    baseURL: string;
    apiKey: string;
    model: string;
    provider?: string;
    codePlanCredentials?: CodePlanCredential[];
    codePlanBaseURL?: string;
    codePlanAnthropicBaseURL?: string;
    ordinaryFallbackModelMap?: Record<string, string>;
    quotaLimits?: {
        fiveHourTokens?: number;
        weeklyTokens?: number;
    };
    quotaMode?: 'fetch' | 'estimated';
    accessKeyId?: string;
    secretAccessKey?: string;
}
export interface ModelRouteTarget {
    upstream: string;
    model?: string;
}
export interface ProxyConfig {
    port?: number;
    host?: string;
    defaultUpstream?: UpstreamConfig;
    upstreamsById?: Record<string, UpstreamConfig>;
    modelRoutes?: Record<string, string | ModelRouteTarget>;
    /** Model keys that route normally but are hidden from the GET /models
     * listing. Used for internal tier aliases (opus/sonnet/haiku) that Claude
     * Code calls under the hood — they must resolve, but should not appear in
     * the user's model picker. */
    hiddenModels?: string[];
}
export interface ProxyRuntimeContext {
    upstreamsByIdMap: Map<string, UpstreamConfig>;
    defaultUpstream: UpstreamConfig | undefined;
    modelRoutesMap: Map<string, ModelRouteTarget>;
    /** Model keys hidden from GET /models but still routable (internal aliases). */
    hiddenModels?: Set<string>;
    codePlanPool?: CodePlanPoolManager;
    metrics?: MetricsCollector;
    quotaFetcher?: QuotaFetcher;
    tokenUsage?: TokenUsageTracker;
}
import type { CodePlanPoolManager } from './codePlanPool';
import type { MetricsCollector } from './metricsCollector';
import type { QuotaFetcher } from './quotaFetcher';
import type { TokenUsageTracker } from './tokenUsageTracker';
export interface ResolvedUpstream {
    upstream: UpstreamConfig;
    modelId: string;
    upstreamRouteId: string;
}
export declare function normalizeUpstream(u: unknown): UpstreamConfig;
export declare function loadConfig(configPathArg?: string): ProxyConfig;
export declare function parseProxyConfigObject(raw: unknown): ProxyConfig;
export declare function normalizeModelRouteTarget(v: string | ModelRouteTarget): ModelRouteTarget;
export declare function buildUpstreamsByIdMap(config: ProxyConfig): ProxyRuntimeContext;
export declare function resolveUpstreamFromModel(modelStr: string, upstreamsByIdMap: Map<string, UpstreamConfig>, defaultUpstream: UpstreamConfig | undefined, modelRoutesMap?: Map<string, ModelRouteTarget>): ResolvedUpstream | null;
export declare function resolveConfigFilePath(configPathArg?: string): string;
