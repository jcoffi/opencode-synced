import type { PluginInput } from '@opencode-ai/plugin';

type Client = PluginInput['client'];

const SERVICE_NAME = 'opencode-synced';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function createLogger(client: Client) {
  return {
    debug: (message: string, extra?: Record<string, unknown>) =>
      log(client, 'debug', message, extra),
    info: (message: string, extra?: Record<string, unknown>) => log(client, 'info', message, extra),
    warn: (message: string, extra?: Record<string, unknown>) => log(client, 'warn', message, extra),
    error: (message: string, extra?: Record<string, unknown>) =>
      log(client, 'error', message, extra),
  };
}

function log(
  client: Client,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
): void {
  client.app
    .log({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        extra,
      },
    })
    .catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(client, `Logging failed: ${errorMsg}`, 'error');
    });
}

export async function showToast(
  client: Client,
  message: string,
  variant: 'info' | 'success' | 'warning' | 'error'
): Promise<void> {
  try {
    await client.tui.showToast({
      body: { title: 'opencode-synced plugin', message, variant },
    });
  } catch {
    // Ignore toast failures (e.g. headless mode or early startup).
  }
}

export function unwrapData<T>(response: unknown): T | null {
  if (!response || typeof response !== 'object') return null;
  const maybeError = (response as { error?: unknown }).error;
  if (maybeError) return null;
  if ('data' in response) {
    const data = (response as { data?: T }).data;
    if (data !== undefined) return data;
    return null;
  }
  return response as T;
}

export function extractTextFromResponse(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;

  const parts =
    (response as { parts?: Array<{ type: string; text?: string }> }).parts ??
    (response as { info?: { parts?: Array<{ type: string; text?: string }> } }).info?.parts ??
    [];

  const textPart = parts.find((part) => part.type === 'text' && part.text);
  return textPart?.text?.trim() ?? null;
}

export interface ModelSelector {
  providerID: string;
  modelID: string;
}

/**
 * Split a `provider/model` selector on its *first* slash, so nested model IDs such as
 * `openrouter/openrouter/fusion-free-fast` keep their full model portion.
 */
export function parseModelSelector(value: string | undefined): ModelSelector | null {
  if (!value) return null;
  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;

  const providerID = value.slice(0, separatorIndex);
  const modelID = value.slice(separatorIndex + 1);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

/**
 * Set of `provider/model` keys the host actually offers, or null when the provider
 * listing is unavailable (older host, transport error). Null means "cannot validate",
 * which is deliberately distinct from "nothing matched".
 */
async function loadAvailableModels(client: Client): Promise<Set<string> | null> {
  try {
    const response = await client.config.providers();
    const data = unwrapData<{
      providers?: Array<{ id?: string; models?: Record<string, unknown> }>;
    }>(response);
    const providers = data?.providers;
    if (!Array.isArray(providers)) return null;

    const available = new Set<string>();
    for (const provider of providers) {
      if (!provider?.id || !provider.models) continue;
      for (const modelID of Object.keys(provider.models)) {
        available.add(`${provider.id}/${modelID}`);
      }
    }
    return available.size > 0 ? available : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the model to use for the plugin's own AI calls.
 *
 * Prefers `small_model`, then falls back to `model`. A configured selector that does
 * not correspond to an available model is skipped rather than returned, so a typo in
 * `small_model` degrades to `model` instead of producing a request against a model
 * that does not exist.
 */
export async function resolveSmallModel(client: Client): Promise<ModelSelector | null> {
  try {
    const response = await client.config.get();
    const config = unwrapData<{ small_model?: string; model?: string }>(response);
    if (!config) return null;

    const candidates: ModelSelector[] = [];
    for (const value of [config.small_model, config.model]) {
      const selector = parseModelSelector(value);
      if (!selector) continue;
      const key = `${selector.providerID}/${selector.modelID}`;
      if (candidates.some((entry) => `${entry.providerID}/${entry.modelID}` === key)) continue;
      candidates.push(selector);
    }
    if (candidates.length === 0) return null;

    const available = await loadAvailableModels(client);
    // Without a provider listing we cannot distinguish a bad selector from an
    // unavailable listing; keep the previous best-effort behaviour rather than
    // refusing to run.
    if (!available) return candidates[0] ?? null;

    for (const candidate of candidates) {
      if (available.has(`${candidate.providerID}/${candidate.modelID}`)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}
