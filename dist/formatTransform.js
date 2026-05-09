"use strict";
// ─── Anthropic Messages API URL builder ──────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAnthropicMessagesURL = buildAnthropicMessagesURL;
function buildAnthropicMessagesURL(baseURL) {
    let url = baseURL.replace(/\/+$/, '');
    if (url.includes('/v1/messages'))
        return [url];
    if (/\/v\d+\/?$/.test(url))
        return [url + '/messages'];
    return [url + '/v1/messages'];
}
