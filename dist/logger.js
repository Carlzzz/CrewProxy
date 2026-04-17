"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.isVerbose = isVerbose;
function isVerbose() {
    const raw = process.env.WOICLAW_PROXY_VERBOSE;
    if (raw === undefined)
        return false;
    const v = raw.trim().toLowerCase();
    return v === '1' || v === 'true';
}
function isoTimestamp() {
    return new Date().toISOString();
}
function formatParts(parts) {
    return parts
        .map((p) => {
        if (typeof p === 'string')
            return p;
        if (p instanceof Error)
            return p.stack ?? p.message;
        try {
            return JSON.stringify(p);
        }
        catch {
            return String(p);
        }
    })
        .join(' ');
}
function line(level, message) {
    return `[${isoTimestamp()}] [${level}] ${message}`;
}
exports.logger = {
    info(...args) {
        console.log(line('INFO', formatParts(args)));
    },
    warn(...args) {
        console.warn(line('WARN', formatParts(args)));
    },
    error(...args) {
        console.error(line('ERROR', formatParts(args)));
    },
    verbose(...args) {
        if (!isVerbose())
            return;
        console.log(line('VERBOSE', formatParts(args)));
    },
};
exports.default = exports.logger;
