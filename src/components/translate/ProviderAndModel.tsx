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

function buildAccountScopedApiKeyStorageKey(
  provider: ProviderId,
  uid: string | null,
): string {
  const accountScope = uid?.trim() || "guest";
  return `translator_api_key_${accountScope}_${provider}`;
}

function buildLegacyApiKeyStorageKey(provider: ProviderId): string {
  return `translator_api_key_${provider}`;
}

const RECOMMENDED_OPENROUTER_GROUP = "grok_budget";
const RECOMMENDED_GROK_MODEL = "x-ai/grok-4.3";

type ProviderApiGuide = {
  actionLabel: string;
  docsLabel: string;
  docsUrl: string;
  footnote?: string;
  intro: string;
  steps: string[];
  title: string;
};

const PROVIDER_API_GUIDES: Record<ProviderId, ProviderApiGuide> = {
  grok: {
    actionLabel: "Hướng dẫn lấy API key Grok",
    title: "Hướng dẫn Grok (xAI)",
    intro: "Lấy API key từ xAI Console để dùng model Grok trong app.",
    steps: [
      "Mở trang xAI Console và đăng nhập tài khoản của bạn.",
      "Vào mục API keys, tạo key mới rồi copy ngay sau khi tạo.",
      "Dán key vào ô API Key trong tab Grok, sau đó bấm Lưu browser hoặc Lưu account.",
    ],
    docsLabel: "Mở xAI API docs",
    docsUrl: "https://docs.x.ai/docs/overview",
    footnote:
      "Nếu key báo lỗi 401/403, kiểm tra lại project quyền truy cập và billing trong xAI Console.",
  },
  openai: {
    actionLabel: "Hướng dẫn lấy API key OpenAI",
    title: "Hướng dẫn ChatGPT API (OpenAI)",
    intro:
      "Bạn cần API key từ OpenAI Platform, không phải key ChatGPT web thông thường.",
    steps: [
      "Đăng nhập OpenAI Platform, vào Dashboard > API keys.",
      "Tạo Secret Key mới và lưu lại ngay vì chỉ hiển thị một lần.",
      "Dán key vào tab ChatGPT API, chọn model phù hợp và lưu key.",
    ],
    docsLabel: "Mở OpenAI API keys",
    docsUrl: "https://platform.openai.com/api-keys",
    footnote:
      "Nếu gọi model thất bại, kiểm tra organization/project và hạn mức usage trên OpenAI dashboard.",
  },
  gemini: {
    actionLabel: "Hướng dẫn lấy API key Gemini",
    title: "Hướng dẫn Gemini API",
    intro: "Gemini API key được quản lý trong Google AI Studio.",
    steps: [
      "Mở Google AI Studio và đăng nhập tài khoản Google.",
      "Vào mục Get API key, tạo key cho project cần dùng.",
      "Copy key, dán vào tab Gemini trong app rồi lưu lại.",
    ],
    docsLabel: "Mở Gemini API key page",
    docsUrl: "https://aistudio.google.com/app/apikey",
    footnote:
      "Một số model Gemini yêu cầu bật region hoặc quota phù hợp trong project Google Cloud.",
  },
  openrouter: {
    actionLabel: "Hướng dẫn lấy API key OpenRouter",
    title: "Hướng dẫn OpenRouter",
    intro:
      "OpenRouter cho phép dùng nhiều model khác nhau qua một API key duy nhất.",
    steps: [
      "Đăng nhập OpenRouter, vào mục Keys và tạo API key.",
      "Nạp credits hoặc cấu hình billing để gọi được model trả phí.",
      "Dán key vào tab OpenRouter, chọn nhóm model rồi lưu key.",
    ],
    docsLabel: "Mở OpenRouter keys",
    docsUrl: "https://openrouter.ai/keys",
    footnote:
      "Nếu model bị fallback, kiểm tra lại model group và quyền truy cập model trong OpenRouter account.",
  },
  huggingface: {
    actionLabel: "Hướng dẫn lấy API key Hugging Face",
    title: "Hướng dẫn Hugging Face",
    intro: "Hugging Face dùng Access Token để gọi Inference API.",
    steps: [
      "Đăng nhập Hugging Face, vào Settings > Access Tokens.",
      "Tạo token mới với quyền đọc/inference phù hợp.",
      "Dán token vào tab Hugging Face và lưu lại.",
    ],
    docsLabel: "Mở Hugging Face tokens",
    docsUrl: "https://huggingface.co/settings/tokens",
    footnote:
      "Nếu response chậm hoặc lỗi model, chọn model nhẹ hơn hoặc kiểm tra trạng thái endpoint inference.",
  },
  ollama: {
    actionLabel: "Hướng dẫn dùng Ollama Local",
    title: "Hướng dẫn Ollama Local",
    intro:
      "Ollama chạy local nên không cần API key, chỉ cần server Ollama đang bật.",
    steps: [
      "Cài Ollama trên máy và chạy dịch vụ Ollama.",
      "Kéo model về bằng lệnh ví dụ: ollama pull qwen3:8b.",
      "Đặt Base URL đúng địa chỉ Ollama local (mặc định http://localhost:11434).",
    ],
    docsLabel: "Mở trang tải Ollama",
    docsUrl: "https://ollama.com/download",
    footnote:
      "Nếu dùng điện thoại để truy cập web app, localhost sẽ không trỏ về máy chủ Ollama trên laptop của bạn.",
  },
};

export function ProviderAndModel() {
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [isApiGuideOpen, setIsApiGuideOpen] = useState(false);
  const [keyHint, setKeyHint] = useState("");
  const provider = useTranslationStore((s) => s.provider);
  const setProvider = useTranslationStore((s) => s.setProvider);
  const apiKey = useTranslationStore((s) => s.apiKey);
  const setApiKey = useTranslationStore((s) => s.setApiKey);
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
  const isApiKeyMissing = !isOllama && !apiKey.trim();
  const isCustomModelMissing = isCustomModel && !customModelName.trim();
  const isSelectedModelUnknown =
    !isCustomModel &&
    !modelOptions.some((modelOption) => modelOption.id === modelSelectValue);
  const providerApiGuide = PROVIDER_API_GUIDES[provider];

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

      const accountScopedStorageKey = buildAccountScopedApiKeyStorageKey(
        provider,
        user?.uid ?? null,
      );

      if (user) {
        const cloudKey = await loadAccountApiKey(provider);
        if (cancelled) return;

        if (cloudKey) {
          setApiKey(cloudKey);
          setKeyHint(`Đã load key cloud cho ${provider}.`);
          return;
        }

        const accountBrowserKey = localStorage.getItem(accountScopedStorageKey);
        if (accountBrowserKey) {
          setApiKey(accountBrowserKey);
          setKeyHint(
            `Đã load key browser của account hiện tại cho ${provider}.`,
          );
          return;
        }

        setApiKey("");
        setKeyHint("");
        return;
      }

      const guestBrowserKey =
        localStorage.getItem(accountScopedStorageKey) ||
        localStorage.getItem(buildLegacyApiKeyStorageKey(provider));
      if (guestBrowserKey) {
        setApiKey(guestBrowserKey);
        setKeyHint(`Đã load key đã lưu trong browser cho ${provider}.`);
        return;
      }

      setApiKey("");
      setKeyHint("");
    }

    void loadSavedKey();
    return () => {
      cancelled = true;
    };
  }, [loadAccountApiKey, provider, setApiKey, user]);

  function saveBrowserApiKey() {
    if (provider === "ollama" || !apiKey.trim()) return;
    const storageKey = buildAccountScopedApiKeyStorageKey(
      provider,
      user?.uid ?? null,
    );
    localStorage.setItem(storageKey, apiKey.trim());
    setKeyHint(`Đã lưu key browser cho ${provider} theo account hiện tại.`);
  }

  async function saveCloudApiKey() {
    if (provider === "ollama" || !apiKey.trim()) return;
    const ok = await saveAccountApiKey(provider, apiKey.trim());
    setKeyHint(
      ok
        ? `Đã lưu key cho ${provider} vào account.`
        : "Không lưu được key lên account.",
    );
  }

  function clearApiKey() {
    if (provider === "ollama") return;
    const storageKey = buildAccountScopedApiKeyStorageKey(
      provider,
      user?.uid ?? null,
    );
    localStorage.removeItem(storageKey);
    if (!user) {
      localStorage.removeItem(buildLegacyApiKeyStorageKey(provider));
    }
    setApiKey("");
    setKeyHint("Đã xóa key khỏi browser.");
  }

  function openApiGuide() {
    setIsApiGuideOpen(true);
  }

  function closeApiGuide() {
    setIsApiGuideOpen(false);
  }

  function applyRecommendedConfiguration() {
    setProvider("openrouter");
    setOpenrouterGroup(RECOMMENDED_OPENROUTER_GROUP);
    setModelSelectValue(RECOMMENDED_GROK_MODEL);
    setKeyHint("Đã áp dụng cấu hình khuyên dùng: OpenRouter + Grok 4.3.");
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
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="provider-guide-row">
        <button
          className="btn btn-primary btn-sm btn-inline-action provider-recommended-btn"
          onClick={applyRecommendedConfiguration}
          type="button"
        >
          Cấu hình khuyên dùng
        </button>
        <button
          className="btn btn-secondary btn-sm btn-inline-action provider-guide-btn"
          onClick={openApiGuide}
          type="button"
        >
          {providerApiGuide.actionLabel}
        </button>
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
            <option value="grok_budget">
              Grok/context lớn/dịch 18+ thoáng
            </option>
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
          <div className="format-row api-key-actions" style={{ marginTop: 8 }}>
            <button
              className="btn btn-secondary btn-sm btn-inline-action"
              onClick={saveBrowserApiKey}
              type="button"
            >
              Lưu browser
            </button>
            {user && (
              <button
                className="btn btn-secondary btn-sm btn-inline-action"
                onClick={() => void saveCloudApiKey()}
                type="button"
              >
                Lưu account
              </button>
            )}
            <button
              className="btn btn-danger btn-danger-ghost btn-sm btn-inline-action"
              onClick={clearApiKey}
              type="button"
            >
              Xóa
            </button>
          </div>
          {isApiKeyMissing && (
            <div className="model-hint model-hint-warning">
              Thiếu API key cho provider hiện tại. Hãy nhập key trước khi bấm
              Bắt đầu dịch.
            </div>
          )}
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
        {isSelectedModelUnknown && (
          <div className="model-hint model-hint-warning">
            Model hiện tại không còn trong danh sách của provider này. Vui lòng
            chọn lại model.
          </div>
        )}
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
          {isCustomModelMissing && (
            <div className="model-hint model-hint-warning">
              Model tùy chỉnh đang trống. Nhập Model ID trước khi bắt đầu dịch.
            </div>
          )}
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

      {isApiGuideOpen && (
        <div className="provider-guide-modal-root">
          <button
            className="provider-guide-modal-dismiss"
            onClick={closeApiGuide}
            type="button"
            aria-label="Đóng hướng dẫn API"
          />
          <dialog
            open
            className="provider-guide-modal-card"
            aria-label={providerApiGuide.title}
          >
            <div className="provider-guide-modal-header">
              <h3>{providerApiGuide.title}</h3>
              <button
                className="btn btn-secondary btn-sm"
                onClick={closeApiGuide}
                type="button"
              >
                Đóng
              </button>
            </div>
            <p className="provider-guide-modal-intro">
              {providerApiGuide.intro}
            </p>
            <ol className="provider-guide-step-list">
              {providerApiGuide.steps.map((stepText, stepIndex) => (
                <li key={`${provider}-${stepIndex}-${stepText}`}>{stepText}</li>
              ))}
            </ol>
            <a
              className="provider-guide-doc-link"
              href={providerApiGuide.docsUrl}
              rel="noreferrer"
              target="_blank"
            >
              {providerApiGuide.docsLabel}
            </a>
            {providerApiGuide.footnote && (
              <p className="provider-guide-footnote">
                {providerApiGuide.footnote}
              </p>
            )}
          </dialog>
        </div>
      )}
    </div>
  );
}
