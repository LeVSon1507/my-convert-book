import type { ProviderId } from "@/lib/providers";

export type RuntimeConfig = {
  defaultProvider?: string;
  defaultModel?: string;
  preferFastTranslation?: boolean;
  keys?: Partial<Record<ProviderId, string>>;
  firebase?: unknown;
};

type TranslatorGlobal = typeof globalThis & {
  TRANSLATOR_CONFIG?: RuntimeConfig;
  TRANSLATOR_LOCAL_CONFIG?: RuntimeConfig;
};

function getTranslatorGlobal(): TranslatorGlobal {
  return globalThis;
}

function isRuntimeConfig(value: unknown): value is RuntimeConfig {
  return Boolean(value && typeof value === "object");
}

function mergeRuntimeConfigs(...configs: RuntimeConfig[]): RuntimeConfig {
  return configs.reduce<RuntimeConfig>(
    (merged, config) => ({
      ...merged,
      ...config,
      keys: {
        ...merged.keys,
        ...config.keys,
      },
    }),
    {},
  );
}

async function loadOptionalLocalConfigScript(): Promise<void> {
  if (typeof document === "undefined") return;
  if (document.querySelector('script[data-translator-local-config="true"]'))
    return;

  await new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.src = "/config/config.local.js";
    script.async = true;
    script.dataset.translatorLocalConfig = "true";
    script.onload = () => resolve();
    script.onerror = () => resolve();
    document.head.appendChild(script);
  });
}

async function fetchServerRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const response = await fetch("/api/runtime-config", { cache: "no-store" });
    if (!response.ok) return {};
    const data: unknown = await response.json();
    return isRuntimeConfig(data) ? data : {};
  } catch {
    return {};
  }
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  await loadOptionalLocalConfigScript();

  const translatorGlobal = getTranslatorGlobal();
  const serverConfig = await fetchServerRuntimeConfig();
  const merged = mergeRuntimeConfigs(
    translatorGlobal.TRANSLATOR_CONFIG ?? {},
    serverConfig,
    translatorGlobal.TRANSLATOR_LOCAL_CONFIG ?? {},
  );

  translatorGlobal.TRANSLATOR_CONFIG = merged;
  return merged;
}
