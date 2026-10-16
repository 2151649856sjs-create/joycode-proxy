/**
 * dsh-llm-joycode — register the JoyCode (JoyCoder) credit pool as a DSH
 * model provider.
 *
 * The provider points at `joycode-proxy` (an OpenAI-compatible loopback server,
 * default http://127.0.0.1:8318/v1) that in turn drives JoyCode's color gateway
 * (HMAC-signed, ptKey-authenticated). Every completion is billed against the
 * same JoyCode account/credits the IDE uses.
 *
 * Host half only: no client half, because the model picker is driven entirely
 * by `ctx.llm.registerAdapter`.
 */
import z from '@deepseek-ai/schemastery';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-llm-joycode';
export const inject = ['llm'];

const STREAM_IDLE_TIMEOUT_MS = 300_000;

/** No per-token pricing is knowable for a credit quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Image budgets at the dsh-llm-pi-ai defaults (required profile fields). */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
};

/** Inert pi-ai auth plane: the proxy authenticates by itself, not via pi-ai. */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error('dsh-llm-joycode: the joycode route has no pi-ai credential lifecycle');
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    },
  },
};

/** Models exposed by the JoyCode backend (kept in sync with joycode-proxy). */
const JOYCODE_MODELS = [
  { id: 'JoyAI-Code-1.6', name: 'JoyAI-Code-1.6', reasoning: true, vision: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'GLM-5.3-agent', name: 'GLM-5.3', reasoning: true, vision: false, contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'Kimi-K2.6-agent', name: 'Kimi-K2.6', reasoning: true, vision: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'MiniMax-M3-agent', name: 'MiniMax-M3', reasoning: true, vision: true, contextWindow: 200_000, maxTokens: 64_000 },
  { id: 'Doubao-Seed-2.0-pro-agent', name: 'Doubao-Seed-2.0-pro', reasoning: true, vision: true, contextWindow: 200_000, maxTokens: 64_000 },
];

export const Config = z.object({
  baseUrl: z.string().description('Base URL of the joycode-proxy OpenAI-compatible endpoint').default('http://127.0.0.1:8318/v1'),
  providerId: z.string().description('Provider id shown to DSH').default('joycode'),
  displayName: z.string().description('Provider display name').default('JoyCode'),
  apiKey: z.string().description('Optional bearer token; leave empty to match joycode-proxy default').default(''),
  enabled: z.boolean().description('Register the provider').default(true),
});

export function apply(ctx, config) {
  ctx = ctx; // keep the cordis context name explicit for readers
  const settings = {
    baseUrl: config.baseUrl ?? 'http://127.0.0.1:8318/v1',
    providerId: config.providerId ?? 'joycode',
    displayName: config.displayName ?? 'JoyCode',
    apiKey: config.apiKey ?? '',
    enabled: config.enabled !== false,
  };

  if (!settings.enabled) return;

  const baseUrl = settings.baseUrl.replace(/\/+$/, '');

  const buildModels = () =>
    JOYCODE_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      api: 'openai-completions',
      provider: settings.providerId,
      baseUrl,
      input: m.vision ? ['text', 'image'] : ['text'],
      reasoning: m.reasoning,
      cost: NO_COST,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: { maxTokensField: 'max_tokens' },
    }));

  const provider = {
    ...createProvider({
      id: settings.providerId,
      name: settings.displayName,
      auth: {
        apiKey: {
          name: 'JoyCode proxy API key',
          async resolve() {
            // The proxy is loopback-only and enforces its own (optional) key.
            return { auth: { apiKey: settings.apiKey || 'joycode-proxy' }, source: 'joycode-proxy' };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const profile = {
    provider: settings.providerId,
    displayName: settings.displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-llm-joycode retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };

  const profiles = new Map([[settings.providerId, profile]]);

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => settings.apiKey || 'joycode-proxy',
  });

  const release = ctx.llm.registerAdapter([settings.providerId], adapter);
  try {
    ctx.effect(() => () => release());
  } catch {
    release();
  }

  ctx.logger?.info?.(
    `dsh-llm-joycode: registered provider "${settings.providerId}" (${JOYCODE_MODELS.length} models) -> ${baseUrl}`,
  );
}
