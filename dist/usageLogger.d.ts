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
}
export declare function formatUTC8(date: Date): string;
export declare function appendUsageLog(clientid: string, modelid: string, startTime: string, inputToken: number, outputToken: number, extra?: UsageLogExtra): void;
