"use client";

import { FormEvent, useState } from "react";
import { useAuthStore } from "@/store/authStore";

type AuthPanelProps = {
  onClose: () => void;
};

export function AuthPanel({ onClose }: AuthPanelProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const user = useAuthStore((s) => s.user);
  const authError = useAuthStore((s) => s.authError);
  const authPending = useAuthStore((s) => s.authPending);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const logout = useAuthStore((s) => s.logout);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ok = await login(email.trim(), password);
    if (ok) onClose();
  }

  async function handleRegister() {
    const ok = await register(email.trim(), password);
    if (ok) onClose();
  }

  async function handleLogout() {
    await logout();
    onClose();
  }

  return (
    <div className="card auth-card header-auth-panel" style={{ display: "block" }}>
      {!user ? (
        <form id="authLoginForm" onSubmit={handleLogin}>
          <div className="auth-header">
            <div className="auth-icon">☁</div>
            <div className="auth-title">Lưu trữ đám mây</div>
            <div className="auth-subtitle">
              Đăng nhập để đồng bộ lịch sử dịch trên mọi thiết bị
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="authEmail">Email</label>
            <input
              autoComplete="email"
              id="authEmail"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="your@email.com"
              type="email"
              value={email}
            />
          </div>
          <div className="form-group">
            <label htmlFor="authPassword">Mật khẩu</label>
            <input
              autoComplete="current-password"
              id="authPassword"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Tối thiểu 6 ký tự"
              type="password"
              value={password}
            />
          </div>
          <div className="auth-error">{authError}</div>
          <button
            className="btn btn-primary btn-full"
            disabled={authPending || !email.trim() || !password}
            id="loginBtn"
            type="submit"
          >
            Đăng nhập
          </button>
          <div className="auth-divider">
            <span>chưa có tài khoản?</span>
          </div>
          <button
            className="btn btn-secondary btn-full"
            disabled={authPending || !email.trim() || password.length < 6}
            id="registerBtn"
            onClick={handleRegister}
            type="button"
          >
            Tạo tài khoản miễn phí
          </button>
        </form>
      ) : (
        <div className="auth-logged-in" style={{ display: "flex" }}>
          <div className="auth-user-info">
            <div className="auth-avatar">✓</div>
            <div>
              <div className="auth-user-label">Đã đăng nhập</div>
              <div className="auth-user-email">{user.email}</div>
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleLogout} type="button">
            Đăng xuất
          </button>
        </div>
      )}
    </div>
  );
}
