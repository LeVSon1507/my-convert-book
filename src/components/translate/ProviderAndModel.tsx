"use client";

import { useEffect, useState } from "react";
import {
  OPENROUTER_MODEL_GROUPS,
  PROVIDER_CONFIGS,
  ProviderId,
  ensureOpenRouterPricingLoaded,
} from "@/lib/providers";
import { useAuthStore } from "@/store/authStore";
import { useTranslationStore } from "@/store/translationStore";

const PROVIDER_TABS: { id: ProviderId; label: string }[] = [
  { id: "grok", label: "Grok (xAI)" },
  { id: "openai", label: "ChatGPT API" },
  { id: "gemini", label: "Gemini" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "huggingface", label: "Hugging Face" },
  { id: "ollama", label: "Ollama Local" },
];

export function ProviderAndModel() {
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [keyHint, setKeyHint] = useState("");
  const provider = useTranslationStore((s) => s.provider);
  const setProvider = useTranslationStore((s) => s.setProvider);
  const apiKey = useTranslationStore((s) => s.apiKey);
  const setApiKey = useTranslationStore((s) => s.setApiKey);
  const runtimeApiKeys = useTranslationStore((s) => s.runtimeApiKeys);
  const baseUrl = useTranslationStore((s) => s.baseUrl);
  const setBaseUrl = useTranslationStore((s) => s.setBaseUrl);
  const modelSelectValue = useTranslationStore((s) => s.modelSelectValue);
  const setModelSelectValue = useTranslationStore((s) => s.setModelSelectValue);
  const customModelName = useTranslationStore((s) => s.customModelName);
  const setCustomModelName = useTranslationStore((s) => s.setCustomModelName);
  const openrouterGroup = useTranslationStore((s) => s.openrouterGroup);
  const setOpenrouterGroup = useTranslationStore((s) => s.setOpenrouterGroup);
  const user = useAuthStore((s) => s.user);
  const saveAccountApiKey = useAuthStore((s) => s.saveApiKey);
  const loadAccountApiKey = useAuthStore((s) => s.loadApiKey);

  const config = PROVIDER_CONFIGS[provider];
  const isOllama = provider === "ollama";
  const isCustomModel = modelSelectValue === "__custom__";
  const modelOptions =
    provider === "openrouter"
      ? (OPENROUTER_MODEL_GROUPS[openrouterGroup]?.models ?? config.models)
      : config.models;

  useEffect(() => {
    if (provider !== "openrouter") return;
    let cancelled = false;
    // Fire-and-forget: refreshes the module-level pricing cache in providers.ts
    // (12h TTL) so getModelPricing() — used by both the cost preview and real
    // post-translation cost — reflects OpenRouter's live prices instead of the
    // static fallback table. Force a store notify afterward so CostPreview
    // (which reads pricing synchronously) picks up the change without
    // requiring an unrelated state edit first.
    void ensureOpenRouterPricingLoaded().then(() => {
      if (!cancelled) useTranslationStore.setState({});
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  useEffect(() => {
    let cancelled = false;

    async function loadSavedKey() {
      if (provider === "ollama") {
        setApiKey("");
        setKeyHint("");
        return;
      }

      const storageKey = `translator_api_key_${provider}`;
      const browserKey = localStorage.getItem(storageKey);
      if (browserKey) {
        setApiKey(browserKey);
        setKeyHint(`Đã load key đã lưu cho ${provider}.`);
        return;
      }

      const runtimeKey = runtimeApiKeys[provider];
      if (runtimeKey) {
        setApiKey(runtimeKey);
        setKeyHint(`Key từ cấu hình runtime cho ${provider}.`);
        return;
      }

      if (!user) {
        setApiKey("");
        setKeyHint("");
        return;
      }

      const cloudKey = await loadAccountApiKey(provider);
      if (cancelled) return;
      setApiKey(cloudKey);
      setKeyHint(cloudKey ? `Đã load key cloud cho ${provider}.` : "");
    }

    void loadSavedKey();
    return () => {
      cancelled = true;
    };
  }, [loadAccountApiKey, provider, runtimeApiKeys, setApiKey, user]);

  function saveBrowserApiKey() {
    if (provider === "ollama" || !apiKey.trim()) return;
    localStorage.setItem(`translator_api_key_${provider}`, apiKey.trim());
    setKeyHint(`Đã lưu key cho ${provider} vào browser.`);
  }

  async function saveCloudApiKey() {
    if (provider === "ollama" || !apiKey.trim()) return;
    const ok = await saveAccountApiKey(provider, apiKey.trim());
    setKeyHint(
      ok ? `Đã lưu key cho ${provider} vào account.` : "Không lưu được key lên account.",
    );
  }

  function clearApiKey() {
    if (provider === "ollama") return;
    localStorage.removeItem(`translator_api_key_${provider}`);
    setApiKey("");
    setKeyHint("Đã xóa key khỏi browser.");
  }

  return (
    <div className="card" id="apiCard">
      <div className="card-title">
        <span className="icon">🔑</span> Cấu hình API
      </div>

      <div className="tabs provider-tabs">
        {PROVIDER_TABS.map(({ id, label }) => (
          <button
            key={id}
            className={`tab ${provider === id ? "active" : ""}`}
            onClick={() => setProvider(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {provider === "openrouter" && (
        <div className="form-group">
          <label htmlFor="openrouterModelGroup">Nhóm model OpenRouter</label>
          <select
            id="openrouterModelGroup"
            value={openrouterGroup}
            onChange={(e) => setOpenrouterGroup(e.target.value)}
          >
            <option value="mistral_translation">Mistral dịch truyện</option>
            <option value="grok_budget">Grok budget/context lớn</option>
            <option value="other">Khác</option>
          </select>
        </div>
      )}

      {!isOllama && (
        <div className="form-group">
          <label htmlFor="apiKey">API Key</label>
          <div className="password-wrapper">
            <input
              autoComplete="off"
              id="apiKey"
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Nhập API key của bạn..."
              type={apiKeyVisible ? "text" : "password"}
              value={apiKey}
            />
            <button
              className="toggle-visibility"
              onClick={() => setApiKeyVisible((value) => !value)}
              title="Hiện/ẩn API key"
              type="button"
            >
              {apiKeyVisible ? "Ẩn" : "Hiện"}
            </button>
          </div>
          <div className="format-row" style={{ marginTop: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={saveBrowserApiKey} type="button">
              Lưu browser
            </button>
            {user && (
              <button className="btn btn-secondary btn-sm" onClick={() => void saveCloudApiKey()} type="button">
                Lưu account
              </button>
            )}
            <button className="btn btn-danger btn-sm" onClick={clearApiKey} type="button">
              Xóa
            </button>
          </div>
          {keyHint && <div className="model-hint">{keyHint}</div>}
        </div>
      )}

      <div className="form-group">
        <label htmlFor="modelSelect">Model</label>
        <select
          id="modelSelect"
          value={modelSelectValue}
          onChange={(e) => setModelSelectValue(e.target.value)}
        >
          {modelOptions.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
        <div className="model-hint">{config.hint}</div>
      </div>

      {isCustomModel && (
        <div className="form-group">
          <label htmlFor="modelName">Model ID (tùy chỉnh)</label>
          <input
            type="text"
            id="modelName"
            placeholder="e.g. x-ai/grok-3-mini"
            value={customModelName}
            onChange={(e) => setCustomModelName(e.target.value)}
          />
        </div>
      )}

      <div className="form-group">
        <label htmlFor="baseUrl">Base URL</label>
        <input
          type="text"
          id="baseUrl"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>
    </div>
  );
}
