"use client";

import Link from "next/link";
import { type ComponentProps, useEffect, useState } from "react";
import { useAuthStore } from "@/store/authStore";

type AccountFormSubmitEvent = Parameters<
  NonNullable<ComponentProps<"form">["onSubmit"]>
>[0];

function normalizeEmailAddress(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeDisplayName(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeUsername(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 32);
}

function isEmailLike(value: string): boolean {
  if (!value || value.includes(" ")) {
    return false;
  }

  const atIndex = value.indexOf("@");
  const dotIndex = value.lastIndexOf(".");
  const hasValidAt = atIndex > 0;
  const hasValidDot = dotIndex > atIndex + 1;
  const hasTail = dotIndex < value.length - 1;

  return hasValidAt && hasValidDot && hasTail;
}

export default function AccountPage() {
  const user = useAuthStore((authState) => authState.user);
  const accountProfile = useAuthStore((authState) => authState.accountProfile);
  const authError = useAuthStore((authState) => authState.authError);
  const authNotice = useAuthStore((authState) => authState.authNotice);
  const authPending = useAuthStore((authState) => authState.authPending);
  const bootstrap = useAuthStore((authState) => authState.bootstrap);
  const clearAuthMessages = useAuthStore(
    (authState) => authState.clearAuthMessages,
  );
  const refreshUserSession = useAuthStore(
    (authState) => authState.refreshUserSession,
  );
  const refreshAccountProfile = useAuthStore(
    (authState) => authState.refreshAccountProfile,
  );
  const saveAccountProfile = useAuthStore(
    (authState) => authState.saveAccountProfile,
  );
  const saveAccountEmail = useAuthStore(
    (authState) => authState.saveAccountEmail,
  );
  const resendVerificationEmail = useAuthStore(
    (authState) => authState.resendVerificationEmail,
  );
  const sendPasswordReset = useAuthStore(
    (authState) => authState.sendPasswordReset,
  );

  const [fullNameDraft, setFullNameDraft] = useState<string | null>(null);
  const [usernameDraft, setUsernameDraft] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [profileError, setProfileError] = useState("");
  const [emailError, setEmailError] = useState("");

  useEffect(() => {
    void bootstrap().then(() => {
      void refreshUserSession();
      void refreshAccountProfile();
    });
  }, [bootstrap, refreshAccountProfile, refreshUserSession]);

  useEffect(() => {
    if (!user || user.emailVerified) {
      return;
    }

    function handleRefetchVerificationState() {
      void refreshUserSession();
      void refreshAccountProfile();
    }

    window.addEventListener("focus", handleRefetchVerificationState);
    document.addEventListener(
      "visibilitychange",
      handleRefetchVerificationState,
    );

    return () => {
      window.removeEventListener("focus", handleRefetchVerificationState);
      document.removeEventListener(
        "visibilitychange",
        handleRefetchVerificationState,
      );
    };
  }, [refreshAccountProfile, refreshUserSession, user]);

  const fullName =
    fullNameDraft ?? accountProfile?.fullName ?? user?.displayName ?? "";
  const username = usernameDraft ?? accountProfile?.username ?? "";
  const email = emailDraft ?? accountProfile?.email ?? user?.email ?? "";

  function handleProfileSubmit(event: AccountFormSubmitEvent) {
    event.preventDefault();
    setProfileError("");
    clearAuthMessages();

    const normalizedFullName = normalizeDisplayName(fullName);
    const normalizedUsername = normalizeUsername(username);

    if (normalizedFullName.length < 2) {
      setProfileError("Tên hiển thị cần ít nhất 2 ký tự.");
      return;
    }

    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(normalizedUsername)) {
      setProfileError("Username gồm 3-32 ký tự, chỉ dùng chữ/số và . _ -.");
      return;
    }

    void saveAccountProfile(normalizedFullName, normalizedUsername);
  }

  function handleEmailSubmit(event: AccountFormSubmitEvent) {
    event.preventDefault();
    setEmailError("");
    clearAuthMessages();

    const normalizedEmail = normalizeEmailAddress(email);

    if (!isEmailLike(normalizedEmail)) {
      setEmailError("Email chưa đúng định dạng.");
      return;
    }

    const hasPasswordProvider = Boolean(user?.providerIds.includes("password"));

    if (hasPasswordProvider && !currentPassword.trim()) {
      setEmailError("Vui lòng nhập mật khẩu hiện tại để xác thực.");
      return;
    }

    void saveAccountEmail(
      normalizedEmail,
      hasPasswordProvider ? currentPassword : "",
    ).then((isSuccess) => {
      if (isSuccess) {
        setCurrentPassword("");
      }
    });
  }

  function handleRefreshVerification() {
    clearAuthMessages();
    void refreshUserSession();
    void refreshAccountProfile();
  }

  function handleSendResetEmail() {
    const normalizedEmail = normalizeEmailAddress(email || user?.email || "");
    clearAuthMessages();
    void sendPasswordReset(normalizedEmail);
  }

  function handleResendVerificationEmail() {
    clearAuthMessages();
    void resendVerificationEmail();
  }

  const emailVerified = user?.emailVerified ?? false;
  const hasPasswordProvider = Boolean(user?.providerIds.includes("password"));

  if (!user) {
    return (
      <div className="app-wrapper">
        <div className="card account-card-empty">
          <h1 className="account-page-title">Quản lý tài khoản</h1>
          <p className="account-page-subtitle">
            Bạn cần đăng nhập để sửa thông tin account.
          </p>
          <Link className="btn btn-primary btn-sm" href="/">
            Về trang chính để đăng nhập
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="app-wrapper">
      <div className="account-page-header">
        <div>
          <h1 className="account-page-title">Quản lý tài khoản</h1>
          <p className="account-page-subtitle">
            Cập nhật tên, username, email và trạng thái bảo mật của tài khoản.
          </p>
        </div>
        <Link className="btn btn-secondary btn-sm" href="/">
          Quay lại studio
        </Link>
      </div>

      <output className={`auth-notice ${authNotice ? "visible" : ""}`}>
        {authNotice}
      </output>
      <div className={`auth-error ${authError ? "visible" : ""}`} role="alert">
        {authError}
      </div>

      <div className="account-page-grid">
        <form className="card account-form-card" onSubmit={handleProfileSubmit}>
          <h2 className="account-form-title">Thông tin cá nhân</h2>

          <div className="form-group">
            <label htmlFor="accountFullName">Tên hiển thị</label>
            <input
              id="accountFullName"
              type="text"
              value={fullName}
              onChange={(changeEvent) =>
                setFullNameDraft(changeEvent.target.value)
              }
              placeholder="Ví dụ: Son Le"
              autoComplete="name"
            />
          </div>

          <div className="form-group">
            <label htmlFor="accountUsername">Username</label>
            <input
              id="accountUsername"
              type="text"
              value={username}
              onChange={(changeEvent) =>
                setUsernameDraft(changeEvent.target.value)
              }
              placeholder="Ví dụ: ten_cua_ban_123"
              autoComplete="username"
            />
          </div>

          <p
            className={`account-inline-error ${profileError ? "visible" : ""}`}
          >
            {profileError}
          </p>

          <button
            className="btn btn-primary btn-sm"
            type="submit"
            disabled={authPending}
          >
            {authPending ? "Đang lưu..." : "Lưu hồ sơ"}
          </button>
        </form>

        <form className="card account-form-card" onSubmit={handleEmailSubmit}>
          <h2 className="account-form-title">Email và bảo mật</h2>

          <div className="account-security-chip-row">
            <span
              className={`account-security-chip ${emailVerified ? "verified" : "pending"}`}
            >
              {emailVerified ? "Email đã xác thực" : "Email chưa xác thực"}
            </span>
          </div>

          <div className="form-group">
            <label htmlFor="accountEmail">Email</label>
            <input
              id="accountEmail"
              type="email"
              value={email}
              onChange={(changeEvent) =>
                setEmailDraft(changeEvent.target.value)
              }
              placeholder="name@email.com"
              autoComplete="email"
            />
          </div>

          {hasPasswordProvider ? (
            <div className="form-group">
              <label htmlFor="accountCurrentPassword">Mật khẩu hiện tại</label>
              <input
                id="accountCurrentPassword"
                type="password"
                value={currentPassword}
                onChange={(changeEvent) =>
                  setCurrentPassword(changeEvent.target.value)
                }
                placeholder="Nhập để xác nhận đổi email"
                autoComplete="current-password"
              />
            </div>
          ) : (
            <p className="account-provider-note">
              Tài khoản đang đăng nhập bằng Google. Khi cập nhật email, hệ thống
              sẽ yêu cầu xác thực lại bằng popup Google.
            </p>
          )}

          <p className={`account-inline-error ${emailError ? "visible" : ""}`}>
            {emailError}
          </p>

          <div className="account-action-row">
            <button
              className="btn btn-primary btn-sm"
              type="submit"
              disabled={authPending}
            >
              {authPending ? "Đang cập nhật..." : "Cập nhật email"}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleRefreshVerification}
              type="button"
              disabled={authPending}
            >
              Làm mới trạng thái xác thực
            </button>
          </div>

          <div className="account-action-row">
            {!emailVerified && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleResendVerificationEmail}
                type="button"
                disabled={authPending}
              >
                Gửi lại email xác thực
              </button>
            )}
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleSendResetEmail}
              type="button"
              disabled={authPending}
            >
              Gửi email đổi mật khẩu
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
