"use client";

import Image from "next/image";
import Link from "next/link";
import { type ComponentProps, useEffect, useState } from "react";
import { type RegisterAuthPayload, useAuthStore } from "@/store/authStore";

type AuthPanelProps = Readonly<{
  onClose: () => void;
}>;

type AuthTab = "login" | "register";

type AuthFormSubmitEvent = Parameters<
  NonNullable<ComponentProps<"form">["onSubmit"]>
>[0];

type AuthInputBlurEvent = Parameters<
  NonNullable<ComponentProps<"input">["onBlur"]>
>[0];

type AuthFormValues = {
  confirmPassword: string;
  email: string;
  fullName: string;
  password: string;
  username: string;
};

type AuthField = keyof AuthFormValues;

type AuthFieldErrors = Record<AuthField, string>;

type AuthPanelCopy = {
  panelTitle: string;
  passwordHelperText: string;
  submitLabel: string;
};

type AuthLoggedOutContentProps = Readonly<{
  activeTab: AuthTab;
  authError: string;
  authNotice: string;
  authPending: boolean;
  canSubmit: boolean;
  fieldErrors: AuthFieldErrors;
  formValues: AuthFormValues;
  hasSubmitted: boolean;
  touchedFields: Partial<Record<AuthField, boolean>>;
  onClose: () => void;
  onFieldBlur: (event: AuthInputBlurEvent) => void;
  onFieldValueChange: (fieldName: AuthField, value: string) => void;
  onGoogleLogin: () => Promise<void>;
  onSendPasswordReset: () => Promise<void>;
  onSubmit: (event: AuthFormSubmitEvent) => Promise<void>;
  onSwitchToLogin: () => void;
  onSwitchToRegister: () => void;
  panelCopy: AuthPanelCopy;
}>;

type AuthLoggedInContentProps = Readonly<{
  authError: string;
  authNotice: string;
  authPending: boolean;
  displayName: string | null;
  email: string | null;
  emailVerified: boolean;
  onClose: () => void;
  onLogout: () => Promise<void>;
  onResendVerification: () => Promise<void>;
}>;

function getAuthPanelCopy(activeTab: AuthTab): AuthPanelCopy {
  if (activeTab === "login") {
    return {
      panelTitle: "Welcome Back",
      submitLabel: "Sign In",
      passwordHelperText: "Nhập mật khẩu tài khoản của bạn",
    };
  }

  return {
    panelTitle: "Create Account",
    submitLabel: "Sign Up",
    passwordHelperText:
      "Mật khẩu ít nhất 8 ký tự, gồm chữ + số để tăng bảo mật.",
  };
}

function getDefaultAuthFormValues(): AuthFormValues {
  return {
    confirmPassword: "",
    email: "",
    fullName: "",
    password: "",
    username: "",
  };
}

function normalizeEmailAddress(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeFullName(value: string): string {
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

function normalizeAuthFormValues(formValues: AuthFormValues): AuthFormValues {
  return {
    ...formValues,
    email: normalizeEmailAddress(formValues.email),
    fullName: normalizeFullName(formValues.fullName),
    username: normalizeUsername(formValues.username),
  };
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

function getAuthFieldErrors(
  activeTab: AuthTab,
  formValues: AuthFormValues,
): AuthFieldErrors {
  const normalizedValues = normalizeAuthFormValues(formValues);
  const errors: AuthFieldErrors = {
    confirmPassword: "",
    email: "",
    fullName: "",
    password: "",
    username: "",
  };

  if (!normalizedValues.email) {
    errors.email = "Vui lòng nhập email.";
  } else if (!isEmailLike(normalizedValues.email)) {
    errors.email = "Email chưa đúng định dạng, ví dụ name@email.com.";
  }

  const isRegisterTab = activeTab === "register";
  const hasLetter = /[A-Za-z]/.test(normalizedValues.password);
  const hasNumber = /\d/.test(normalizedValues.password);
  const minPasswordLength = isRegisterTab ? 8 : 6;

  if (!normalizedValues.password) {
    errors.password = "Vui lòng nhập mật khẩu.";
  } else if (normalizedValues.password.length < minPasswordLength) {
    errors.password = `Mật khẩu cần ít nhất ${minPasswordLength} ký tự.`;
  } else if (isRegisterTab && (!hasLetter || !hasNumber)) {
    errors.password = "Mật khẩu cần có cả chữ và số.";
  }

  if (!isRegisterTab) {
    return errors;
  }

  if (!normalizedValues.fullName) {
    errors.fullName = "Vui lòng nhập tên hiển thị.";
  } else if (normalizedValues.fullName.length < 2) {
    errors.fullName = "Tên hiển thị cần ít nhất 2 ký tự.";
  }

  if (!normalizedValues.username) {
    errors.username = "Vui lòng nhập username.";
  } else if (!/^[a-zA-Z0-9._-]{3,32}$/.test(normalizedValues.username)) {
    errors.username = "Username gồm 3-32 ký tự, chỉ dùng chữ/số và . _ -.";
  }

  if (!normalizedValues.confirmPassword) {
    errors.confirmPassword = "Vui lòng nhập lại mật khẩu.";
  } else if (normalizedValues.confirmPassword !== normalizedValues.password) {
    errors.confirmPassword = "Mật khẩu nhập lại chưa khớp.";
  }

  return errors;
}

function canSubmitAuth(
  activeTab: AuthTab,
  formValues: AuthFormValues,
): boolean {
  const fieldErrors = getAuthFieldErrors(activeTab, formValues);
  return Object.values(fieldErrors).every((fieldError) => !fieldError);
}

type AuthFieldErrorParams = {
  fieldErrors: AuthFieldErrors;
  fieldName: AuthField;
  hasSubmitted: boolean;
  touchedFields: Partial<Record<AuthField, boolean>>;
};

function resolveFieldErrorMessage({
  fieldErrors,
  fieldName,
  hasSubmitted,
  touchedFields,
}: AuthFieldErrorParams): string {
  const shouldShowError = Boolean(touchedFields[fieldName] || hasSubmitted);
  if (!shouldShowError) {
    return "";
  }
  return fieldErrors[fieldName] || "";
}

type AuthFieldInputProps = Readonly<{
  autoComplete: string;
  fieldName: AuthField;
  formValues: AuthFormValues;
  icon: string;
  id: string;
  label: string;
  onFieldBlur: (event: AuthInputBlurEvent) => void;
  onFieldValueChange: (fieldName: AuthField, value: string) => void;
  placeholder: string;
  type: "email" | "password" | "text";
  validationError: string;
}>;

function AuthFieldInput({
  autoComplete,
  fieldName,
  formValues,
  icon,
  id,
  label,
  onFieldBlur,
  onFieldValueChange,
  placeholder,
  type,
  validationError,
}: AuthFieldInputProps) {
  return (
    <div className="form-group auth-form-group">
      <label htmlFor={id}>{label}</label>
      <div className="auth-input-shell">
        <span className="auth-input-icon" aria-hidden="true">
          {icon}
        </span>
        <input
          autoComplete={autoComplete}
          id={id}
          name={fieldName}
          onBlur={onFieldBlur}
          onChange={(changeEvent) =>
            onFieldValueChange(fieldName, changeEvent.target.value)
          }
          placeholder={placeholder}
          type={type}
          value={formValues[fieldName]}
        />
      </div>
      <p className={`auth-field-error ${validationError ? "visible" : ""}`}>
        {validationError}
      </p>
    </div>
  );
}

type AuthRegisterFieldsProps = Readonly<{
  fieldErrors: AuthFieldErrors;
  formValues: AuthFormValues;
  hasSubmitted: boolean;
  onFieldBlur: (event: AuthInputBlurEvent) => void;
  onFieldValueChange: (fieldName: AuthField, value: string) => void;
  touchedFields: Partial<Record<AuthField, boolean>>;
}>;

function AuthRegisterFields({
  fieldErrors,
  formValues,
  hasSubmitted,
  onFieldBlur,
  onFieldValueChange,
  touchedFields,
}: AuthRegisterFieldsProps) {
  const fullNameError = resolveFieldErrorMessage({
    fieldErrors,
    fieldName: "fullName",
    hasSubmitted,
    touchedFields,
  });
  const usernameError = resolveFieldErrorMessage({
    fieldErrors,
    fieldName: "username",
    hasSubmitted,
    touchedFields,
  });
  const confirmPasswordError = resolveFieldErrorMessage({
    fieldErrors,
    fieldName: "confirmPassword",
    hasSubmitted,
    touchedFields,
  });

  return (
    <>
      <AuthFieldInput
        autoComplete="name"
        fieldName="fullName"
        formValues={formValues}
        icon="✦"
        id="authFullName"
        label="Tên hiển thị"
        onFieldBlur={onFieldBlur}
        onFieldValueChange={onFieldValueChange}
        placeholder="Ví dụ: Le Van A"
        type="text"
        validationError={fullNameError}
      />
      <AuthFieldInput
        autoComplete="username"
        fieldName="username"
        formValues={formValues}
        icon="#"
        id="authPublicUsername"
        label="Username"
        onFieldBlur={onFieldBlur}
        onFieldValueChange={onFieldValueChange}
        placeholder="Ví dụ: son_le_123"
        type="text"
        validationError={usernameError}
      />
      <AuthFieldInput
        autoComplete="new-password"
        fieldName="confirmPassword"
        formValues={formValues}
        icon="✓"
        id="authConfirmPassword"
        label="Nhập lại mật khẩu"
        onFieldBlur={onFieldBlur}
        onFieldValueChange={onFieldValueChange}
        placeholder="Nhập lại mật khẩu"
        type="password"
        validationError={confirmPasswordError}
      />
    </>
  );
}

function AuthLoggedOutContent({
  activeTab,
  authError,
  authNotice,
  authPending,
  canSubmit,
  fieldErrors,
  formValues,
  hasSubmitted,
  touchedFields,
  onClose,
  onFieldBlur,
  onFieldValueChange,
  onGoogleLogin,
  onSendPasswordReset,
  onSubmit,
  onSwitchToLogin,
  onSwitchToRegister,
  panelCopy,
}: AuthLoggedOutContentProps) {
  const isLoginTab = activeTab === "login";
  const emailError = resolveFieldErrorMessage({
    fieldErrors,
    fieldName: "email",
    hasSubmitted,
    touchedFields,
  });
  const passwordError = resolveFieldErrorMessage({
    fieldErrors,
    fieldName: "password",
    hasSubmitted,
    touchedFields,
  });

  return (
    <>
      <button
        className="auth-close"
        onClick={onClose}
        type="button"
        aria-label="Đóng"
      >
        ✕
      </button>

      <div className="auth-branding">
        <div className="auth-brand-icon" aria-hidden="true">
          ⌘
        </div>
        <div className="auth-brand-title">TranslateFlow</div>
        <p className="auth-brand-subtitle">
          Transform your text, preserve every meaning
        </p>
      </div>

      <div className="auth-panel-title" id="authPanelTitle">
        {panelCopy.panelTitle}
      </div>

      <Image
        src={
          isLoginTab
            ? "/login-page/auth-login-illustration.svg"
            : "/login-page/auth-register-illustration.svg"
        }
        alt={isLoginTab ? "Login illustration" : "Register illustration"}
        className="auth-hero-illustration"
        width={240}
        height={132}
        priority={false}
      />

      <div className="auth-tab-switch" role="tablist" aria-label="Auth mode">
        <button
          className={`auth-tab ${isLoginTab ? "active" : ""}`}
          onClick={onSwitchToLogin}
          type="button"
          role="tab"
          aria-selected={isLoginTab}
        >
          Sign In
        </button>
        <button
          className={`auth-tab ${!isLoginTab ? "active" : ""}`}
          onClick={onSwitchToRegister}
          type="button"
          role="tab"
          aria-selected={!isLoginTab}
        >
          Sign Up
        </button>
      </div>

      <button
        className="btn btn-secondary btn-full auth-google-btn"
        onClick={() => void onGoogleLogin()}
        type="button"
        disabled={authPending}
      >
        {authPending ? "Processing..." : "Sign in with Google"}
      </button>

      <div className="auth-or-divider" aria-hidden="true">
        <span>hoặc dùng email</span>
      </div>

      <form id="authLoginForm" onSubmit={onSubmit}>
        <AuthFieldInput
          autoComplete="email"
          fieldName="email"
          formValues={formValues}
          icon="@"
          id="authEmail"
          label="Email"
          onFieldBlur={onFieldBlur}
          onFieldValueChange={onFieldValueChange}
          placeholder="vidu@email.com"
          type="email"
          validationError={emailError}
        />

        {!isLoginTab ? (
          <AuthRegisterFields
            fieldErrors={fieldErrors}
            formValues={formValues}
            hasSubmitted={hasSubmitted}
            onFieldBlur={onFieldBlur}
            onFieldValueChange={onFieldValueChange}
            touchedFields={touchedFields}
          />
        ) : null}

        <div className="form-group auth-form-group">
          <label htmlFor="authPassword">Mật khẩu</label>
          <div className="auth-input-shell">
            <span className="auth-input-icon" aria-hidden="true">
              ⟡
            </span>
            <input
              autoComplete={isLoginTab ? "current-password" : "new-password"}
              id="authPassword"
              name="password"
              onBlur={onFieldBlur}
              onChange={(changeEvent) =>
                onFieldValueChange("password", changeEvent.target.value)
              }
              placeholder={
                isLoginTab
                  ? "Nhập mật khẩu của bạn"
                  : "Tối thiểu 8 ký tự, gồm chữ và số"
              }
              type="password"
              value={formValues.password}
            />
          </div>
          <p className={`auth-field-error ${passwordError ? "visible" : ""}`}>
            {passwordError}
          </p>
          <p className="auth-password-helper">{panelCopy.passwordHelperText}</p>

          {isLoginTab && (
            <button
              className="auth-text-action"
              onClick={() => void onSendPasswordReset()}
              type="button"
              disabled={authPending}
            >
              Quên mật khẩu? Gửi email đặt lại mật khẩu
            </button>
          )}
        </div>

        <output className={`auth-notice ${authNotice ? "visible" : ""}`}>
          {authNotice}
        </output>

        <div
          className={`auth-error ${authError ? "visible" : ""}`}
          role="alert"
        >
          {authError}
        </div>

        <button
          className="btn btn-primary btn-full auth-submit"
          disabled={authPending || !canSubmit}
          type="submit"
        >
          {authPending ? "Processing..." : panelCopy.submitLabel}
        </button>
      </form>
    </>
  );
}

function AuthLoggedInContent({
  authError,
  authNotice,
  authPending,
  displayName,
  email,
  emailVerified,
  onClose,
  onLogout,
  onResendVerification,
}: AuthLoggedInContentProps) {
  const displayedEmail = email ?? "unknown@account";
  const displayedName = displayName || "Người dùng";

  return (
    <div className="auth-logged-in">
      <button
        className="auth-close"
        onClick={onClose}
        type="button"
        aria-label="Đóng"
      >
        ✕
      </button>

      <div className="auth-logged-in-header">
        <div className="auth-user-info">
          <div className="auth-avatar">✓</div>
          <div>
            <div className="auth-user-label">Đã đăng nhập</div>
            <div className="auth-user-name">{displayedName}</div>
            <div className="auth-user-email">{displayedEmail}</div>
          </div>
        </div>
        <div className="auth-session-chip">
          {emailVerified
            ? "Email đã xác thực"
            : "Email chưa xác thực - nên xác thực để bảo mật"}
        </div>
        <p className="auth-logged-in-note">
          Bạn có thể tiếp tục dịch, lịch sử sẽ được lưu trên cloud.
        </p>

        <output className={`auth-notice ${authNotice ? "visible" : ""}`}>
          {authNotice}
        </output>

        <div
          className={`auth-error ${authError ? "visible" : ""}`}
          role="alert"
        >
          {authError}
        </div>
      </div>

      <div className="auth-logged-in-actions">
        {!emailVerified && (
          <button
            className="btn btn-secondary btn-sm auth-resend-btn"
            onClick={() => void onResendVerification()}
            type="button"
            disabled={authPending}
          >
            {authPending ? "Đang gửi..." : "Gửi lại email xác thực"}
          </button>
        )}
        <Link
          href="/account"
          className="btn btn-secondary btn-sm auth-account-btn"
          onClick={onClose}
        >
          Sửa thông tin tài khoản
        </Link>
        <button
          className="btn btn-secondary btn-sm auth-logout-btn"
          onClick={onLogout}
          type="button"
        >
          Đăng xuất
        </button>
      </div>
    </div>
  );
}

export function AuthPanel({ onClose }: AuthPanelProps) {
  const [activeTab, setActiveTab] = useState<AuthTab>("login");
  const [formValues, setFormValues] = useState<AuthFormValues>(
    getDefaultAuthFormValues(),
  );
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [touchedFields, setTouchedFields] = useState<
    Partial<Record<AuthField, boolean>>
  >({});
  const user = useAuthStore((authState) => authState.user);
  const authError = useAuthStore((authState) => authState.authError);
  const authNotice = useAuthStore((authState) => authState.authNotice);
  const authPending = useAuthStore((authState) => authState.authPending);
  const login = useAuthStore((authState) => authState.login);
  const loginWithGoogle = useAuthStore(
    (authState) => authState.loginWithGoogle,
  );
  const register = useAuthStore((authState) => authState.register);
  const logout = useAuthStore((authState) => authState.logout);
  const clearAuthMessages = useAuthStore(
    (authState) => authState.clearAuthMessages,
  );
  const sendPasswordReset = useAuthStore(
    (authState) => authState.sendPasswordReset,
  );
  const resendVerificationEmail = useAuthStore(
    (authState) => authState.resendVerificationEmail,
  );
  const refreshUserSession = useAuthStore(
    (authState) => authState.refreshUserSession,
  );

  useEffect(() => {
    if (!user || user.emailVerified) {
      return;
    }

    function handleRefetchVerificationState() {
      void refreshUserSession();
    }

    handleRefetchVerificationState();

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
  }, [refreshUserSession, user]);

  function updateFormField(fieldName: AuthField, value: string) {
    setFormValues((previousValues) => ({
      ...previousValues,
      [fieldName]: value,
    }));
  }

  async function handleAuthSubmit(event: AuthFormSubmitEvent) {
    event.preventDefault();
    setHasSubmitted(true);
    const normalizedValues = normalizeAuthFormValues(formValues);
    const isLoginTab = activeTab === "login";
    const fieldErrors = getAuthFieldErrors(activeTab, normalizedValues);
    const canSubmitAuthForm = Object.values(fieldErrors).every(
      (fieldError) => !fieldError,
    );

    if (!canSubmitAuthForm) {
      return;
    }

    let isSuccess = false;
    if (isLoginTab) {
      isSuccess = await login(
        normalizedValues.email,
        normalizedValues.password,
      );
    } else {
      const registerPayload: RegisterAuthPayload = {
        email: normalizedValues.email,
        password: normalizedValues.password,
        fullName: normalizedValues.fullName,
        username: normalizedValues.username,
      };
      isSuccess = await register(registerPayload);
    }

    if (!isSuccess) {
      return;
    }

    if (isLoginTab) {
      setFormValues(getDefaultAuthFormValues());
      setHasSubmitted(false);
      setTouchedFields({});
      onClose();
      return;
    }

    setActiveTab("login");
    setHasSubmitted(false);
    setTouchedFields({});
    setFormValues(() => ({
      ...getDefaultAuthFormValues(),
      email: normalizedValues.email,
    }));
  }

  async function handleLogout() {
    await logout();
    onClose();
  }

  async function handleSendPasswordReset() {
    const normalizedEmail = normalizeEmailAddress(formValues.email);
    await sendPasswordReset(normalizedEmail);
  }

  async function handleResendVerificationEmail() {
    await resendVerificationEmail();
  }

  async function handleGoogleLogin() {
    const isSuccess = await loginWithGoogle();
    if (isSuccess) {
      onClose();
    }
  }

  function handleSwitchToLogin() {
    setActiveTab("login");
    setHasSubmitted(false);
    setTouchedFields({});
    clearAuthMessages();
  }

  function handleSwitchToRegister() {
    setActiveTab("register");
    setHasSubmitted(false);
    setTouchedFields({});
    clearAuthMessages();
  }

  function handleFieldBlur(event: AuthInputBlurEvent) {
    const fieldName = event.currentTarget.name as AuthField;
    const authFields: AuthField[] = [
      "email",
      "fullName",
      "username",
      "password",
      "confirmPassword",
    ];

    if (!authFields.includes(fieldName)) {
      return;
    }

    setTouchedFields((previousState) => ({
      ...previousState,
      [fieldName]: true,
    }));
  }

  const panelCopy = getAuthPanelCopy(activeTab);
  const fieldErrors = getAuthFieldErrors(activeTab, formValues);
  const canSubmit = canSubmitAuth(activeTab, formValues);

  return (
    <div className="auth-modal">
      <button
        className="auth-backdrop"
        onClick={onClose}
        type="button"
        aria-label="Đóng cửa sổ đăng nhập"
      />
      <dialog
        className="card auth-card auth-surface"
        open
        aria-labelledby="authPanelTitle"
      >
        {!user ? (
          <AuthLoggedOutContent
            activeTab={activeTab}
            authError={authError}
            authNotice={authNotice}
            authPending={authPending}
            canSubmit={canSubmit}
            fieldErrors={fieldErrors}
            formValues={formValues}
            hasSubmitted={hasSubmitted}
            touchedFields={touchedFields}
            onClose={onClose}
            onFieldBlur={handleFieldBlur}
            onFieldValueChange={updateFormField}
            onGoogleLogin={handleGoogleLogin}
            onSendPasswordReset={handleSendPasswordReset}
            onSubmit={handleAuthSubmit}
            onSwitchToLogin={handleSwitchToLogin}
            onSwitchToRegister={handleSwitchToRegister}
            panelCopy={panelCopy}
          />
        ) : (
          <AuthLoggedInContent
            authError={authError}
            authNotice={authNotice}
            authPending={authPending}
            displayName={user.displayName}
            email={user.email}
            emailVerified={user.emailVerified}
            onClose={onClose}
            onLogout={handleLogout}
            onResendVerification={handleResendVerificationEmail}
          />
        )}
      </dialog>
    </div>
  );
}
