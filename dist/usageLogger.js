"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatUTC8 = formatUTC8;
exports.appendUsageLog = appendUsageLog;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const logger_1 = __importDefault(require("./logger"));
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 104857600;
const MIN_MAX_BYTES = 1048576;
function formatUTC8(date) {
    const shifted = new Date(date.getTime() + UTC8_OFFSET_MS);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    const h = String(shifted.getUTCHours()).padStart(2, '0');
    const min = String(shifted.getUTCMinutes()).padStart(2, '0');
    const s = String(shifted.getUTCSeconds()).padStart(2, '0');
    const ms = String(shifted.getUTCMilliseconds()).padStart(3, '0');
    return `${y}-${m}-${d}T${h}:${min}:${s}.${ms}+08:00`;
}
function dateStampUTC8(date) {
    const shifted = new Date(date.getTime() + UTC8_OFFSET_MS);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
function getLogDir() {
    return process.env.WOICLAW_LOG_DIR || './logs';
}
function getMaxBytes() {
    const raw = process.env.WOICLAW_USAGE_LOG_MAX_BYTES;
    let n = DEFAULT_MAX_BYTES;
    if (raw !== undefined && raw !== '') {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            n = parsed;
        }
    }
    return Math.max(n, MIN_MAX_BYTES);
}
function resolveUsageLogPath(dir, dateStr, maxBytes) {
    for (let n = 1;; n += 1) {
        const filePath = n === 1
            ? path.join(dir, `usage-${dateStr}.jsonl`)
            : path.join(dir, `usage-${dateStr}-${n}.jsonl`);
        try {
            const { size } = fs.statSync(filePath);
            if (size < maxBytes) {
                return filePath;
            }
        }
        catch (err) {
            const e = err;
            if (e.code === 'ENOENT') {
                return filePath;
            }
            throw err;
        }
    }
}
function costTimeSeconds(startTime, end) {
    const start = new Date(startTime);
    if (!Number.isFinite(start.getTime())) {
        return '0.00';
    }
    return ((end.getTime() - start.getTime()) / 1000).toFixed(2);
}
function appendUsageLog(clientid, modelid, startTime, inputToken, outputToken, extra) {
    setImmediate(() => {
        try {
            const now = new Date();
            const dir = getLogDir();
            fs.mkdirSync(dir, { recursive: true });
            const dateStr = dateStampUTC8(now);
            const maxBytes = getMaxBytes();
            const filePath = resolveUsageLogPath(dir, dateStr, maxBytes);
            const e = extra;
            const record = {
                app: e?.app ?? 'woicrew',
                clientid,
                username: e?.username ?? null,
                modelid,
                input_token: inputToken,
                output_token: outputToken,
                input_cached_token: e?.input_cached_token ?? 0,
                start_time: startTime,
                out_time: formatUTC8(now),
                cost_time: costTimeSeconds(startTime, now),
                request_size: e?.request_size ?? null,
                response_size: e?.response_size ?? null,
                stream: e?.stream ?? null,
                input_content: e?.input_content ?? null,
                output_content: e?.output_content ?? null,
                input_fulltext: e?.input_fulltext ?? null,
                session_id: e?.session_id !== undefined ? e.session_id : null,
                routing_key: e?.routing_key ?? null,
                status: e?.status ?? null,
                error: e?.error ?? null,
            };
            fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
        }
        catch (err) {
            logger_1.default.error('appendUsageLog failed', err);
        }
    });
}
