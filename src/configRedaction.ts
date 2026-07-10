import type { ProxyConfig, UpstreamConfig, CodePlanCredential } from './config';

export type RedactedCredential = Omit<CodePlanCredential, 'apiKey'> & {
  hasApiKey: boolean;
  apiKeyMasked: string;
};

export type RedactedUpstream = Omit<UpstreamConfig, 'apiKey' | 'codePlanCredentials' | 'secretAccessKey'> & {
  hasApiKey: boolean;
  apiKeyMasked: string;
  hasSecretAccessKey?: boolean;
  secretAccessKeyMasked?: string;
  codePlanCredentials?: RedactedCredential[];
};

export type RedactedProxyConfig = Omit<ProxyConfig, 'defaultUpstream' | 'upstreamsById'> & {
  defaultUpstream?: RedactedUpstream;
  upstreamsById?: Record<string, RedactedUpstream>;
};

/**
 * Mask a secret string, keeping only the last 4 characters (prefixed with `****`).
 * Returns an empty string for null/undefined/empty input, and `****` for strings
 * of 4 characters or shorter (nothing to reveal).
 */
export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return '';
  if (secret.length <= 4) return '****';
  return '****' + secret.slice(-4);
}

function redactCredential(c: CodePlanCredential): RedactedCredential {
  const { apiKey, ...rest } = c;
  return { ...rest, hasApiKey: Boolean(apiKey), apiKeyMasked: maskSecret(apiKey) };
}

function redactUpstream(u: UpstreamConfig): RedactedUpstream {
  const { apiKey, codePlanCredentials, secretAccessKey, ...rest } = u;
  const out: RedactedUpstream = {
    ...rest,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
  };
  // Volcengine SecretAccessKey is a secret; accessKeyId (kept in ...rest) is an identifier.
  if (secretAccessKey !== undefined) {
    out.hasSecretAccessKey = Boolean(secretAccessKey);
    out.secretAccessKeyMasked = maskSecret(secretAccessKey);
  }
  if (codePlanCredentials) out.codePlanCredentials = codePlanCredentials.map(redactCredential);
  return out;
}

/**
 * Produce a deeply-redacted copy of a ProxyConfig where every `apiKey` field
 * (on the default upstream, all upstreamsById entries, and their codePlanCredentials)
 * is replaced by `{ hasApiKey, apiKeyMasked }`. The full apiKey value is never
 * present in the returned object.
 */
export function redactProxyConfig(config: ProxyConfig): RedactedProxyConfig {
  const { defaultUpstream: _du, upstreamsById: _u, ...rest } = config;
  const out: RedactedProxyConfig = { ...rest };
  if (config.defaultUpstream) out.defaultUpstream = redactUpstream(config.defaultUpstream);
  if (config.upstreamsById) {
    out.upstreamsById = {};
    for (const [id, u] of Object.entries(config.upstreamsById)) {
      out.upstreamsById[id] = redactUpstream(u);
    }
  }
  return out;
}
