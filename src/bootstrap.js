export async function resolveFirebaseConfig() {
  const local =
    globalThis.TRANSLATOR_LOCAL_CONFIG &&
    globalThis.TRANSLATOR_LOCAL_CONFIG.firebase;
  if (local && local.apiKey) {
    globalThis.FIREBASE_CONFIG = local;
    return;
  }

  const protocol =
    globalThis.location && globalThis.location.protocol
      ? globalThis.location.protocol
      : '';
  const isHttp = protocol === 'http:' || protocol === 'https:';
  if (!isHttp) return;

  try {
    const res = await fetch('/api/firebase-config');
    if (res.ok && res.status !== 204) {
      const cfg = await res.json();
      if (cfg.apiKey) globalThis.FIREBASE_CONFIG = cfg;
    }
  } catch {
    // Ignore network errors in local-only mode.
  }
}

function mergeRuntimeConfig(source) {
  if (!source || typeof source !== 'object') return;

  const base = globalThis.TRANSLATOR_CONFIG || {};
  const baseKeys = base.keys && typeof base.keys === 'object' ? base.keys : {};
  const sourceKeys = source.keys && typeof source.keys === 'object' ? source.keys : {};

  globalThis.TRANSLATOR_CONFIG = {
    ...base,
    ...source,
    keys: {
      ...baseKeys,
      ...sourceKeys
    }
  };
}

export function applyLocalRuntimeConfig() {
  const local = globalThis.TRANSLATOR_LOCAL_CONFIG;
  if (!local || typeof local !== 'object') return;

  mergeRuntimeConfig({
    defaultProvider: local.defaultProvider,
    defaultModel: local.defaultModel,
    keys: local.keys || {}
  });
}

export async function resolveServerRuntimeConfig() {
  const protocol =
    globalThis.location && globalThis.location.protocol
      ? globalThis.location.protocol
      : '';
  const isHttp = protocol === 'http:' || protocol === 'https:';
  if (!isHttp) return;

  try {
    const res = await fetch('/api/runtime-config');
    if (!res.ok || res.status === 204) return;
    const cfg = await res.json();
    mergeRuntimeConfig(cfg);
  } catch {
    // Ignore runtime-config fetch errors in local-only mode.
  }
}

export async function loadOptionalLocalConfig() {
  await new Promise(function (resolve) {
    const script = document.createElement('script');
    script.src = '/config/config.local.js';
    script.async = false;
    script.onload = resolve;
    script.onerror = resolve;
    document.head.appendChild(script);
  });
}

export async function loadLegacyScripts() {
  const scripts = [
    '/scripts/translate/01-state-and-boot.js',
    '/scripts/translate/02-provider-and-model-config.js',
    '/scripts/translate/03-model-loading-and-base-utils.js',
    '/scripts/translate/04-translation-quality-utils.js',
    '/scripts/translate/05-cost-and-provider-ui.js',
    '/scripts/translate/06-api-key-and-checkpoint.js',
    '/scripts/translate/07-history-and-file-loading.js',
    '/scripts/translate/08-chunking-and-runtime-controls.js',
    '/scripts/translate/09a-translate-chunk.js',
    '/scripts/translate/09b-process-chunks.js',
    '/scripts/translate/10-translation-runner.js',
    '/scripts/translate/11-export-and-result.js',
    '/scripts/translate/12-ui-events-and-reset.js',
    '/scripts/writing/01-analysis-and-prompts.js',
    '/scripts/writing/02-api-and-writing-flow.js',
    '/scripts/writing/03-writing-ui-actions.js',
    '/scripts/cloud.js'
  ];

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = reject;
      document.body.appendChild(script);
    });
  }

  for (const src of scripts) {
    await loadScript(src);
  }
}

export async function loadAppHtmlPartial() {
  const mount = document.getElementById('appContentMount');
  if (!mount) return;
  if (mount.dataset.hydrated === 'true') return;

  const partialPath = mount.dataset.partial || '/partials/app-content.html';
  const response = await fetch(partialPath, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Không tải được partial giao diện: ${partialPath}`);
  }
  mount.innerHTML = await response.text();
  mount.dataset.hydrated = 'true';
}

export async function bootstrapApp() {
  await loadOptionalLocalConfig();
  await resolveServerRuntimeConfig();
  applyLocalRuntimeConfig();
  await resolveFirebaseConfig();
  await loadAppHtmlPartial();
  await loadLegacyScripts();
  if (typeof globalThis.bootApp === 'function') {
    globalThis.bootApp();
  }
}
