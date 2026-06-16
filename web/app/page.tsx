"use client";

import { useState } from "react";

type AppMode = "translate" | "writing" | "history";

const MODE_TABS: { mode: AppMode; label: string }[] = [
  { mode: "translate", label: "Dịch mới" },
  { mode: "writing", label: "Viết tiếp truyện" },
  { mode: "history", label: "Lịch sử" },
];

export default function Home() {
  const [activeMode, setActiveMode] = useState<AppMode>("translate");

  return (
    <div className="app-wrapper">
      <div className="header">
        <div className="header-top-row">
          <div className="header-badge">Trình Dịch Truyện AI</div>
          <button className="btn btn-secondary btn-sm header-auth-btn">
            Đăng nhập
          </button>
        </div>
        <h1>Dịch Truyện Chất Lượng Cao</h1>
        <p className="header-subtitle">
          Hỗ trợ file .txt lớn (15–20 MB), dịch sang tiếng Việt thuần bằng
          Grok, ChatGPT API, Gemini hoặc OpenRouter
        </p>
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

      {activeMode === "translate" && (
        <div className="card">
          <p>Khu vực Dịch mới — sẽ được component hóa ở Phase 4.</p>
        </div>
      )}
      {activeMode === "writing" && (
        <div className="card">
          <p>Khu vực Viết tiếp truyện — sẽ được component hóa ở Phase 5.</p>
        </div>
      )}
      {activeMode === "history" && (
        <div className="card">
          <p>Khu vực Lịch sử — sẽ được component hóa ở Phase 6.</p>
        </div>
      )}
    </div>
  );
}
