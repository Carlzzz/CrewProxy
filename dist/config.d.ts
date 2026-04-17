export interface UpstreamConfig {
    baseURL: string;
    apiKey: string;
    model: string;
    provider?: string;
}
export interface ProxyConfig {
    port?: number;
    host?: string;
    defaultUpstream?: UpstreamConfig;
    upstreamsById?: Record<string, UpstreamConfig>;
    modelRoutes?: Record<string, string>;
}
export interface ProxyRuntimeContext {
    upstreamsByIdMap: Map<string, UpstreamConfig>;
    defaultUpstream: UpstreamConfig | undefined;
    modelRoutesMap: Map<string, string>;
}
export interface ResolvedUpstream {
    upstream: UpstreamConfig;
    modelId: string;
    upstreamRouteId: string;
}
export declare function normalizeUpstream(u: unknown): UpstreamConfig;
export declare function loadConfig(configPathArg?: string): ProxyConfig;
export declare function parseProxyConfigObject(raw: unknown): ProxyConfig;
export declare function buildUpstreamsByIdMap(config: ProxyConfig): ProxyRuntimeContext;
export declare function resolveUpstreamFromModel(modelStr: string, upstreamsByIdMap: Map<string, UpstreamConfig>, defaultUpstream: UpstreamConfig | undefined, modelRoutesMap?: Map<string, string>): ResolvedUpstream | null;
