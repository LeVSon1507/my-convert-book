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
  const scripts = ['/scripts/translate.js', '/scripts/writing.js', '/scripts/cloud.js'];

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

export async function bootstrapApp() {
  await loadOptionalLocalConfig();
  await resolveServerRuntimeConfig();
  applyLocalRuntimeConfig();
  await resolveFirebaseConfig();
  await loadLegacyScripts();
  if (typeof globalThis.bootApp === 'function') {
    globalThis.bootApp();
  }
}
