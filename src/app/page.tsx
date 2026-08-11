"use client";

import Image from "next/image";
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
  { mode: "translate", label: "Bắt đầu dịch" },
  { mode: "writing", label: "Viết tiếp mượt hơn" },
  { mode: "history", label: "Lịch sử bản dịch" },
];

export default function Home() {
  const [activeMode, setActiveMode] = useState<AppMode>("translate");
  const [authPanelOpen, setAuthPanelOpen] = useState(false);
  const [isHeaderScrolled, setIsHeaderScrolled] = useState(false);
  const user = useAuthStore((authState) => authState.user);
  const bootstrapAuth = useAuthStore((authState) => authState.bootstrap);

  function handleToggleAuthPanel() {
    setAuthPanelOpen((isPanelOpen) => !isPanelOpen);
  }

  function handleCloseAuthPanel() {
    setAuthPanelOpen(false);
  }

  function handleSelectMode(mode: AppMode) {
    setActiveMode(mode);
  }

  function handleResumeToTranslate() {
    setActiveMode("translate");
  }

  useEffect(() => {
    void bootstrapAuth();
    void loadRuntimeConfig().then((config) => {
      useTranslationStore.getState().applyRuntimeConfig(config);
    });
  }, [bootstrapAuth]);

  useEffect(() => {
    function updateHeaderCompactState() {
      const shouldCompactHeader = window.scrollY > 24;
      setIsHeaderScrolled(shouldCompactHeader);
    }

    updateHeaderCompactState();
    window.addEventListener("scroll", updateHeaderCompactState, {
      passive: true,
    });

    return () => {
      window.removeEventListener("scroll", updateHeaderCompactState);
    };
  }, []);

  const authButtonLabel =
    user?.displayName || user?.email?.split("@")[0] || "Đăng nhập";

  return (
    <div className="app-wrapper">
      <div className={`header ${isHeaderScrolled ? "is-scrolled" : ""}`.trim()}>
        <div className="header-top-row">
          <div
            className="header-badge"
            aria-label="AI Story Translation Studio"
          >
            <span className="header-badge-kicker">AI Story</span>
            <span className="header-badge-divider" aria-hidden="true" />
            <span className="header-badge-label">Translation Studio</span>
          </div>
          <button
            className="btn btn-secondary btn-sm header-auth-btn"
            onClick={handleToggleAuthPanel}
            type="button"
          >
            {authButtonLabel}
          </button>
        </div>

        <div className="header-main">
          <div className="header-main-copy">
            <h1 className="header-title">
              Biến truyện gốc thành bản{" "}
              <span className="headline-accent">Việt cuốn hút</span> ngay từ
              chương đầu
            </h1>
            <p className="header-subtitle">
              Upload file lớn, dịch nhanh và giữ đúng mạch cảm xúc nhân vật. Hỗ
              trợ Grok, ChatGPT API, Gemini, OpenRouter để bạn chọn chất giọng
              phù hợp từng thể loại.
            </p>
          </div>
          <Image
            src="/undraw-img/undraw-hero-ai-providers.svg"
            alt="AI provider illustration"
            className="illustration header-hero-illustration"
            width={180}
            height={110}
            priority={false}
          />
        </div>
      </div>

      <div className="card mode-tabs-card">
        <div className="tabs mode-tabs">
          {MODE_TABS.map(({ mode, label }) => (
            <button
              key={mode}
              className={`tab ${activeMode === mode ? "active" : ""}`}
              onClick={() => handleSelectMode(mode)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {activeMode === "translate" && <TranslateWorkspace />}
      {activeMode === "writing" && <WritingWorkspace />}
      {activeMode === "history" && (
        <HistoryWorkspace onResume={handleResumeToTranslate} />
      )}

      {authPanelOpen && <AuthPanel onClose={handleCloseAuthPanel} />}
    </div>
  );
}
