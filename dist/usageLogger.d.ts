export interface UsageLogExtra {
    app?: string;
    username?: string;
    input_cached_token?: number;
    request_size?: number;
    response_size?: number;
    stream?: boolean;
    input_content?: string;
    output_content?: string;
    input_fulltext?: string;
    session_id?: string | null;
    routing_key?: string;
    /** Final HTTP status for this request. 200 on success; the upstream status
     *  (e.g. 429/500) or 502 on failure. Historical records predate this field. */
    status?: number;
    /** Short error summary for failed requests (network error code, upstream
     *  error text, or "all credentials exhausted"). null on success. */
    error?: string;
}
export declare function formatUTC8(date: Date): string;
export declare function appendUsageLog(clientid: string, modelid: string, startTime: string, inputToken: number, outputToken: number, extra?: UsageLogExtra): void;
