"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeUpstream = normalizeUpstream;
exports.loadConfig = loadConfig;
exports.parseProxyConfigObject = parseProxyConfigObject;
exports.normalizeModelRouteTarget = normalizeModelRouteTarget;
exports.buildUpstreamsByIdMap = buildUpstreamsByIdMap;
exports.resolveUpstreamFromModel = resolveUpstreamFromModel;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("./logger");
function ensureString(v, field) {
    if (v === undefined || v === null) {
        throw new Error(`${field} is required`);
    }
    if (typeof v === "string") {
        return v;
    }
    return String(v);
}
function normalizeUpstream(u) {
    if (u === null || typeof u !== "object") {
        throw new Error("upstream must be an object");
    }
    const o = u;
    const baseURL = ensureString(o.baseURL, "baseURL").replace(/\/+$/, "");
    const apiKey = ensureString(o.apiKey, "apiKey");
    const model = ensureString(o.model, "model");
    const out = { baseURL, apiKey, model };
    if (o.provider !== undefined && o.provider !== null) {
        out.provider = ensureString(o.provider, "provider");
    }
    return out;
}
function readConfigFile(filePath) {
    try {
        const text = fs_1.default.readFileSync(filePath, "utf8");
        const raw = JSON.parse(text);
        return parseProxyConfigObject(raw);
    }
    catch (e) {
        logger_1.logger.error("Failed to load config file", filePath, e);
        throw e;
    }
}
function loadFromEnvUpstream() {
    const baseURL = process.env.UPSTREAM_BASE_URL;
    const apiKey = process.env.UPSTREAM_API_KEY;
    const model = process.env.UPSTREAM_MODEL;
    if (baseURL === undefined || apiKey === undefined || model === undefined) {
        return null;
    }
    const config = {
        defaultUpstream: normalizeUpstream({
            baseURL,
            apiKey,
            model,
            provider: process.env.UPSTREAM_PROVIDER,
        }),
    };
    const portRaw = process.env.PORT;
    if (portRaw !== undefined) {
        const p = Number(portRaw);
        if (!Number.isNaN(p)) {
            config.port = p;
        }
    }
    return config;
}
function loadConfig(configPathArg) {
    if (configPathArg !== undefined && configPathArg !== "") {
        const resolved = path_1.default.isAbsolute(configPathArg)
            ? configPathArg
            : path_1.default.resolve(process.cwd(), configPathArg);
        return readConfigFile(resolved);
    }
    const envPath = process.env.WOICLAW_PROXY_CONFIG;
    if (envPath !== undefined && envPath !== "") {
        const resolved = path_1.default.isAbsolute(envPath)
            ? envPath
            : path_1.default.resolve(process.cwd(), envPath);
        return readConfigFile(resolved);
    }
    const defaultFile = path_1.default.join(process.cwd(), "proxy-config.json");
    if (fs_1.default.existsSync(defaultFile)) {
        return readConfigFile(defaultFile);
    }
    const fromEnv = loadFromEnvUpstream();
    if (fromEnv !== null) {
        return fromEnv;
    }
    throw new Error("No proxy configuration found: set config path, WOICLAW_PROXY_CONFIG, proxy-config.json, or UPSTREAM_* env vars");
}
function parseProxyConfigObject(raw) {
    if (raw === null || typeof raw !== "object") {
        throw new Error("config must be an object");
    }
    const r = raw;
    const out = {};
    if (typeof r.port === "number") {
        out.port = r.port;
    }
    if (typeof r.host === "string") {
        out.host = r.host;
    }
    if (r.defaultUpstream !== undefined) {
        out.defaultUpstream = normalizeUpstream(r.defaultUpstream);
    }
    if (r.upstreamsById !== undefined) {
        if (r.upstreamsById === null || typeof r.upstreamsById !== "object") {
            throw new Error("upstreamsById must be an object");
        }
        const rec = {};
        for (const [id, u] of Object.entries(r.upstreamsById)) {
            rec[id] = normalizeUpstream(u);
        }
        out.upstreamsById = rec;
    }
    if (r.modelRoutes !== undefined) {
        if (r.modelRoutes === null || typeof r.modelRoutes !== "object") {
            throw new Error("modelRoutes must be an object");
        }
        const routes = {};
        for (const [model, target] of Object.entries(r.modelRoutes)) {
            if (target !== null && typeof target === "object") {
                const t = target;
                routes[model] = {
                    upstream: String(t.upstream),
                    model: t.model !== undefined ? String(t.model) : undefined,
                };
            }
            else {
                routes[model] = String(target);
            }
        }
        out.modelRoutes = routes;
    }
    return out;
}
function normalizeModelRouteTarget(v) {
    if (typeof v === "string") {
        return { upstream: v };
    }
    return v;
}
function buildUpstreamsByIdMap(config) {
    const upstreamsByIdMap = new Map();
    if (config.upstreamsById !== undefined) {
        for (const [id, u] of Object.entries(config.upstreamsById)) {
            upstreamsByIdMap.set(id, u);
        }
    }
    const modelRoutesMap = new Map();
    if (config.modelRoutes !== undefined) {
        for (const [model, target] of Object.entries(config.modelRoutes)) {
            modelRoutesMap.set(model, normalizeModelRouteTarget(target));
        }
    }
    return {
        upstreamsByIdMap,
        defaultUpstream: config.defaultUpstream,
        modelRoutesMap,
    };
}
function resolveUpstreamFromModel(modelStr, upstreamsByIdMap, defaultUpstream, modelRoutesMap) {
    const pipe = modelStr.indexOf("|");
    if (pipe !== -1) {
        const upstreamId = modelStr.slice(0, pipe);
        const modelIdPart = modelStr.slice(pipe + 1);
        const named = upstreamsByIdMap.get(upstreamId);
        if (named !== undefined) {
            const modelId = modelIdPart === "" ? named.model : modelIdPart;
            return {
                upstream: named,
                modelId,
                upstreamRouteId: upstreamId,
            };
        }
        if (defaultUpstream !== undefined) {
            const modelId = modelIdPart === ""
                ? defaultUpstream.model
                : modelIdPart;
            return {
                upstream: defaultUpstream,
                modelId,
                upstreamRouteId: "__default__",
            };
        }
        return null;
    }
    if (modelRoutesMap && modelStr !== "") {
        const routeTarget = modelRoutesMap.get(modelStr);
        if (routeTarget !== undefined) {
            const routed = upstreamsByIdMap.get(routeTarget.upstream);
            if (routed !== undefined) {
                const modelId = routeTarget.model ?? modelStr;
                return {
                    upstream: routed,
                    modelId,
                    upstreamRouteId: routeTarget.upstream,
                };
            }
            logger_1.logger.error(`modelRoutes maps "${modelStr}" to upstream "${routeTarget.upstream}" but that upstream is not in upstreamsById`);
        }
    }
    if (defaultUpstream === undefined) {
        return null;
    }
    const modelId = modelStr === "" ? defaultUpstream.model : modelStr;
    return {
        upstream: defaultUpstream,
        modelId,
        upstreamRouteId: "__default__",
    };
}
