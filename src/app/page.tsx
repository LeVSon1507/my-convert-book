"use client";

import { useEffect, useState } from "react";
import { AuthPanel } from "@/components/auth/AuthPanel";
import { HistoryWorkspace } from "@/components/history/HistoryWorkspace";
import { TranslateWorkspace } from "@/components/translate/TranslateWorkspace";
import { WritingWorkspace } from "@/components/writing/WritingWorkspace";
import { loadRuntimeConfig } from "@/lib/runtimeConfig";
import { useAuthStore } from "@/store/authStore";
import { useTranslationStore } from "@/store/translationStore";

type AppMode = "translate" | "writing" | "history";

const MODE_TABS: { mode: AppMode; label: string }[] = [
  { mode: "translate", label: "Dịch mới" },
  { mode: "writing", label: "Viết tiếp truyện" },
  { mode: "history", label: "Lịch sử" },
];

export default function Home() {
  const [activeMode, setActiveMode] = useState<AppMode>("translate");
  const [authPanelOpen, setAuthPanelOpen] = useState(false);
  const user = useAuthStore((s) => s.user);
  const bootstrapAuth = useAuthStore((s) => s.bootstrap);

  useEffect(() => {
    void bootstrapAuth();
    void loadRuntimeConfig().then((config) => {
      useTranslationStore.getState().applyRuntimeConfig(config);
    });
  }, [bootstrapAuth]);

  const authButtonLabel = user?.email?.split("@")[0] || "Đăng nhập";

  return (
    <div className="app-wrapper">
      <div className="header">
        <div className="header-top-row">
          <div className="header-badge">Trình Dịch Truyện AI</div>
          <button
            className="btn btn-secondary btn-sm header-auth-btn"
            onClick={() => setAuthPanelOpen((value) => !value)}
            type="button"
          >
            {authButtonLabel}
          </button>
        </div>
        <h1>Dịch Truyện Chất Lượng Cao</h1>
        <p className="header-subtitle">
          Hỗ trợ file .txt lớn (15–20 MB), dịch sang tiếng Việt thuần bằng Grok,
          ChatGPT API, Gemini hoặc OpenRouter
        </p>
        {authPanelOpen && <AuthPanel onClose={() => setAuthPanelOpen(false)} />}
      </div>

      <div className="card" style={{ padding: 12 }}>
        <div className="tabs">
          {MODE_TABS.map(({ mode, label }) => (
            <button
              key={mode}
              className={`tab ${activeMode === mode ? "active" : ""}`}
              onClick={() => setActiveMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeMode === "translate" && <TranslateWorkspace />}
      {activeMode === "writing" && <WritingWorkspace />}
      {activeMode === "history" && (
        <HistoryWorkspace onResume={() => setActiveMode("translate")} />
      )}
    </div>
  );
}
