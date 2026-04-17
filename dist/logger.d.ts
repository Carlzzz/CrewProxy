export declare function isVerbose(): boolean;
export declare const logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    verbose(...args: unknown[]): void;
};
export default logger;
