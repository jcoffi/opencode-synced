import type { PluginInput } from '@opencode-ai/plugin';
import { describe, expect, it, vi } from 'vitest';

import { resolveSmallModel } from './utils.js';

type Client = PluginInput['client'];

function createClient(config: { small_model?: string; model?: string } | null): Client {
  return {
    config: {
      get: vi.fn().mockResolvedValue(config ? { data: config } : { data: null }),
    },
  } as unknown as Client;
}

describe('resolveSmallModel', () => {
  it('resolves a standard small_model selector', async () => {
    const client = createClient({ small_model: 'openai/gpt-5.5-fast' });

    await expect(resolveSmallModel(client)).resolves.toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.5-fast',
    });
  });

  it('preserves nested model IDs in small_model', async () => {
    const client = createClient({ small_model: 'openrouter/openrouter/free:exacto' });

    await expect(resolveSmallModel(client)).resolves.toEqual({
      providerID: 'openrouter',
      modelID: 'openrouter/free:exacto',
    });
  });

  it('falls back to model when small_model is missing', async () => {
    const client = createClient({ model: 'openrouter/models/with/multiple/segments' });

    await expect(resolveSmallModel(client)).resolves.toEqual({
      providerID: 'openrouter',
      modelID: 'models/with/multiple/segments',
    });
  });

  it.each([
    { label: 'missing separator', value: 'openai' },
    { label: 'leading separator', value: '/gpt-5.5-fast' },
    { label: 'trailing separator', value: 'openai/' },
  ])('returns null for $label', async ({ value }) => {
    const client = createClient({ small_model: value });

    await expect(resolveSmallModel(client)).resolves.toBeNull();
  });
});

function createClientWithProviders(
  config: { small_model?: string; model?: string } | null,
  providers: Array<{ id: string; models: Record<string, unknown> }> | null
): Client {
  return {
    config: {
      get: vi.fn().mockResolvedValue(config ? { data: config } : { data: null }),
      providers:
        providers === null
          ? vi.fn().mockRejectedValue(new Error('providers unavailable'))
          : vi.fn().mockResolvedValue({ data: { providers } }),
    },
  } as unknown as Client;
}

const OPENROUTER = {
  id: 'openrouter',
  models: { 'openrouter/fusion-free-fast': {}, 'openrouter/free:exacto': {} },
};
const ZAI = { id: 'zai-coding-plan', models: { 'glm-5.3-flash': {} } };

describe('resolveSmallModel validation', () => {
  it('returns small_model when it exists', async () => {
    const client = createClientWithProviders(
      { small_model: 'openrouter/openrouter/fusion-free-fast', model: 'zai-coding-plan/glm-5.3-flash' },
      [OPENROUTER, ZAI]
    );

    await expect(resolveSmallModel(client)).resolves.toEqual({
      providerID: 'openrouter',
      modelID: 'openrouter/fusion-free-fast',
    });
  });

  it('falls back to model when small_model does not exist', async () => {
    // Regression: a selector missing one path segment resolved to a nonexistent model
    // and every plugin AI call failed instead of degrading to `model`.
    const client = createClientWithProviders(
      { small_model: 'openrouter/fusion-free-fast', model: 'zai-coding-plan/glm-5.3-flash' },
      [OPENROUTER, ZAI]
    );

    await expect(resolveSmallModel(client)).resolves.toEqual({
      providerID: 'zai-coding-plan',
      modelID: 'glm-5.3-flash',
    });
  });

  it('returns null when neither configured model exists', async () => {
    const client = createClientWithProviders(
      { small_model: 'openrouter/nope', model: 'openrouter/also-nope' },
      [OPENROUTER, ZAI]
    );

    await expect(resolveSmallModel(client)).resolves.toBeNull();
  });

  it('keeps best-effort behaviour when the provider listing is unavailable', async () => {
    const client = createClientWithProviders(
      { small_model: 'openrouter/fusion-free-fast', model: 'zai-coding-plan/glm-5.3-flash' },
      null
    );

    await expect(resolveSmallModel(client)).resolves.toEqual({
      providerID: 'openrouter',
      modelID: 'fusion-free-fast',
    });
  });

  it('does not treat an empty provider listing as authoritative', async () => {
    const client = createClientWithProviders({ small_model: 'openrouter/fusion-free-fast' }, []);

    await expect(resolveSmallModel(client)).resolves.toEqual({
      providerID: 'openrouter',
      modelID: 'fusion-free-fast',
    });
  });
});
