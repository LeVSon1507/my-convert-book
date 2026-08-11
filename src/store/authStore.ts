import { create } from "zustand";
import {
  CloudAccountProfile,
  TranslationHistoryEntry,
  firebaseAuthMessage,
  initFirebase,
  loadAccountProfile as loadAccountProfileFromFirestore,
  loadAccountCustomModels,
  loadCloudHistory,
  rememberCustomModelForAccount,
  saveApiKey as saveApiKeyToFirestore,
  loadApiKey as loadApiKeyFromFirestore,
  refreshCurrentUserSession,
  saveAccountProfile as saveAccountProfileToFirestore,
  savePrompts as savePromptsToFirestore,
  loadPrompts as loadPromptsFromFirestore,
  saveTranslationSettings as saveTranslationSettingsToFirestore,
  loadTranslationSettings as loadTranslationSettingsFromFirestore,
  sendPasswordResetForEmail,
  sendVerificationEmailToCurrentUser,
  signInWithGoogleAccount,
  ProviderPrompts,
  CloudProviderTranslationSettings,
  CloudTranslationSettings,
  signIn,
  signOutUser,
  signUp,
  subscribeToAuthChanges,
  updateAccountEmail as updateAccountEmailInFirestore,
} from "@/lib/firebase";

export type CloudUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailVerified: boolean;
  providerIds: string[];
};

export type RegisterAuthPayload = {
  email: string;
  password: string;
  fullName: string;
  username: string;
};

type AuthState = {
  bootstrapped: boolean;
  user: CloudUser | null;
  authError: string;
  authNotice: string;
  authPending: boolean;
  accountProfile: CloudAccountProfile | null;
  customModelsByProvider: Record<string, string[]>;
  cloudHistory: TranslationHistoryEntry[];

  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  loginWithGoogle: () => Promise<boolean>;
  register: (payload: RegisterAuthPayload) => Promise<boolean>;
  logout: () => Promise<void>;
  clearAuthMessages: () => void;
  sendPasswordReset: (email: string) => Promise<boolean>;
  resendVerificationEmail: () => Promise<boolean>;
  refreshUserSession: () => Promise<void>;
  refreshAccountProfile: () => Promise<void>;
  saveAccountProfile: (fullName: string, username: string) => Promise<boolean>;
  saveAccountEmail: (
    nextEmail: string,
    currentPassword: string,
  ) => Promise<boolean>;
  rememberCustomModel: (provider: string, modelId: string) => Promise<void>;
  refreshCloudHistory: () => Promise<void>;
  saveApiKey: (provider: string, apiKey: string) => Promise<boolean>;
  loadApiKey: (provider: string) => Promise<string>;
  savePrompts: (provider: string, prompts: ProviderPrompts) => Promise<boolean>;
  loadPrompts: (provider: string) => Promise<ProviderPrompts | null>;
  saveTranslationSettings: (
    provider: string,
    settings: CloudProviderTranslationSettings,
  ) => Promise<boolean>;
  loadTranslationSettings: () => Promise<CloudTranslationSettings | null>;
};

const EMAIL_SPAM_HINT =
  "Nếu không thấy email gửi đến, hãy kiểm tra hộp thư rác (spam) của bạn.";

async function syncUserData(
  uid: string,
  email: string | null,
  set: (partial: Partial<AuthState>) => void,
): Promise<void> {
  const [customModelsByProvider, cloudHistory, accountProfile] =
    await Promise.all([
      loadAccountCustomModels(uid),
      loadCloudHistory(uid),
      loadAccountProfileFromFirestore(uid).catch(() => ({
        email,
        emailVerified: false,
        fullName: "",
        username: "",
      })),
    ]);
  set({ customModelsByProvider, cloudHistory, accountProfile });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  bootstrapped: false,
  user: null,
  authError: "",
  authNotice: "",
  authPending: false,
  accountProfile: null,
  customModelsByProvider: {},
  cloudHistory: [],

  async bootstrap() {
    if (get().bootstrapped) return;
    set({ bootstrapped: true });

    try {
      const res = await fetch("/api/firebase-config");
      const config = res.ok ? await res.json() : null;
      if (!initFirebase(config)) return;
    } catch {
      return;
    }

    subscribeToAuthChanges((firebaseUser) => {
      if (!firebaseUser) {
        set({
          user: null,
          accountProfile: null,
          customModelsByProvider: {},
          cloudHistory: [],
        });
        return;
      }
      const user = {
        uid: firebaseUser.uid,
        email: firebaseUser.email,
        displayName: firebaseUser.displayName,
        emailVerified: firebaseUser.emailVerified,
        providerIds: firebaseUser.providerData
          .map((providerProfile) => providerProfile.providerId)
          .filter(Boolean),
      };
      set({ user });
      syncUserData(user.uid, user.email, set).catch((e) =>
        console.error("Cloud sync error:", e),
      );
    });
  },

  async login(email, password) {
    set({ authError: "", authNotice: "", authPending: true });
    try {
      await signIn(email, password);
      await get().refreshUserSession();

      if (!get().user?.emailVerified) {
        set({
          authNotice:
            "Email chưa xác thực. Bạn vẫn có thể dùng app, nhưng nên kiểm tra hộp thư để xác thực tài khoản.",
        });
      } else {
        set({ authNotice: "Đăng nhập thành công." });
      }
      return true;
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "unknown";
      set({ authError: firebaseAuthMessage(code) });
      return false;
    } finally {
      set({ authPending: false });
    }
  },

  async register(payload) {
    set({ authError: "", authNotice: "", authPending: true });
    try {
      await signUp(payload);
      set({
        authNotice: `Đăng ký thành công. Hệ thống đã gửi email xác thực đến hộp thư của bạn. ${EMAIL_SPAM_HINT}`,
      });
      return true;
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "unknown";
      set({ authError: firebaseAuthMessage(code) });
      return false;
    } finally {
      set({ authPending: false });
    }
  },

  async loginWithGoogle() {
    set({ authError: "", authNotice: "", authPending: true });
    try {
      await signInWithGoogleAccount();
      set({ authNotice: "Đăng nhập Google thành công." });
      return true;
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "unknown";
      set({ authError: firebaseAuthMessage(code) });
      return false;
    } finally {
      set({ authPending: false });
    }
  },

  async logout() {
    set({ authError: "", authNotice: "" });
    await signOutUser();
  },

  clearAuthMessages() {
    set({ authError: "", authNotice: "" });
  },

  async sendPasswordReset(email) {
    const normalizedEmail = String(email || "").trim();
    if (!normalizedEmail) {
      set({ authError: "Vui lòng nhập email để nhận link đổi mật khẩu." });
      return false;
    }

    set({ authError: "", authNotice: "", authPending: true });
    try {
      await sendPasswordResetForEmail(normalizedEmail);
      set({
        authNotice: `Đã gửi email đổi mật khẩu. Vui lòng kiểm tra hộp thư. ${EMAIL_SPAM_HINT}`,
      });
      return true;
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "unknown";
      set({ authError: firebaseAuthMessage(code) });
      return false;
    } finally {
      set({ authPending: false });
    }
  },

  async resendVerificationEmail() {
    set({ authError: "", authNotice: "", authPending: true });
    try {
      await sendVerificationEmailToCurrentUser();
      set({
        authNotice: `Đã gửi lại email xác thực. Vui lòng kiểm tra hộp thư. ${EMAIL_SPAM_HINT}`,
      });
      return true;
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "unknown";
      set({ authError: firebaseAuthMessage(code) });
      return false;
    } finally {
      set({ authPending: false });
    }
  },

  async refreshUserSession() {
    try {
      const refreshedUser = await refreshCurrentUserSession();
      if (!refreshedUser) return;

      set({
        user: {
          uid: refreshedUser.uid,
          email: refreshedUser.email,
          displayName: refreshedUser.displayName,
          emailVerified: refreshedUser.emailVerified,
          providerIds: refreshedUser.providerData
            .map((providerProfile) => providerProfile.providerId)
            .filter(Boolean),
        },
      });

      const accountProfile = await loadAccountProfileFromFirestore(
        refreshedUser.uid,
      );
      set({ accountProfile });
    } catch (error) {
      console.error("Refresh user session error:", error);
    }
  },

  async refreshAccountProfile() {
    const uid = get().user?.uid;
    if (!uid) return;
    try {
      const accountProfile = await loadAccountProfileFromFirestore(uid);
      set({ accountProfile });
    } catch (error) {
      console.error("Load account profile error:", error);
    }
  },

  async saveAccountProfile(fullName, username) {
    const uid = get().user?.uid;
    if (!uid) {
      set({ authError: "Bạn cần đăng nhập để cập nhật hồ sơ." });
      return false;
    }

    set({ authError: "", authNotice: "", authPending: true });
    try {
      const accountProfile = await saveAccountProfileToFirestore(
        uid,
        fullName,
        username,
      );
      const previousUser = get().user;
      set({
        accountProfile,
        authNotice: "Đã cập nhật thông tin tài khoản.",
        user: previousUser
          ? {
              ...previousUser,
              displayName: accountProfile.fullName || previousUser.displayName,
            }
          : previousUser,
      });
      return true;
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "unknown";
      set({ authError: firebaseAuthMessage(code) });
      return false;
    } finally {
      set({ authPending: false });
    }
  },

  async saveAccountEmail(nextEmail, currentPassword) {
    const uid = get().user?.uid;
    if (!uid) {
      set({ authError: "Bạn cần đăng nhập để cập nhật email." });
      return false;
    }

    set({ authError: "", authNotice: "", authPending: true });
    try {
      const accountProfile = await updateAccountEmailInFirestore(
        uid,
        nextEmail,
        currentPassword,
      );
      const previousUser = get().user;
      set({
        accountProfile,
        authNotice: `Đã cập nhật email. Hệ thống đã gửi email xác thực đến địa chỉ mới. ${EMAIL_SPAM_HINT}`,
        user: previousUser
          ? {
              ...previousUser,
              email: accountProfile.email,
              emailVerified: accountProfile.emailVerified,
            }
          : previousUser,
      });
      return true;
    } catch (error) {
      const code = (error as { code?: string })?.code ?? "unknown";
      set({ authError: firebaseAuthMessage(code) });
      return false;
    } finally {
      set({ authPending: false });
    }
  },

  async rememberCustomModel(provider, modelId) {
    const safeModelId = String(modelId || "").trim();
    if (!safeModelId || safeModelId === "__custom__") return;

    const existingList = get().customModelsByProvider[provider] ?? [];
    const optimisticList = [
      safeModelId,
      ...existingList.filter((item) => item !== safeModelId),
    ].slice(0, 30);
    set({
      customModelsByProvider: {
        ...get().customModelsByProvider,
        [provider]: optimisticList,
      },
    });

    const uid = get().user?.uid;
    if (!uid) return;
    try {
      const persistedList = await rememberCustomModelForAccount(
        uid,
        provider,
        safeModelId,
        existingList,
      );
      set({
        customModelsByProvider: {
          ...get().customModelsByProvider,
          [provider]: persistedList,
        },
      });
    } catch (e) {
      console.error("Cloud save custom model error:", e);
    }
  },

  async refreshCloudHistory() {
    const uid = get().user?.uid;
    if (!uid) return;
    try {
      set({ cloudHistory: await loadCloudHistory(uid) });
    } catch (e) {
      console.error("Load cloud history error:", e);
    }
  },

  async saveApiKey(provider, apiKey) {
    const uid = get().user?.uid;
    if (!uid || !provider || !apiKey) return false;
    try {
      await saveApiKeyToFirestore(uid, provider, apiKey);
      return true;
    } catch (e) {
      console.error("Cloud save api key error:", e);
      return false;
    }
  },

  async loadApiKey(provider) {
    const uid = get().user?.uid;
    if (!uid || !provider) return "";
    try {
      return await loadApiKeyFromFirestore(uid, provider);
    } catch (e) {
      console.error("Cloud load api key error:", e);
      return "";
    }
  },

  async savePrompts(provider, prompts) {
    const uid = get().user?.uid;
    if (!uid || !provider) return false;
    try {
      await savePromptsToFirestore(uid, provider, prompts);
      return true;
    } catch (e) {
      console.error("Cloud save prompts error:", e);
      return false;
    }
  },

  async loadPrompts(provider) {
    const uid = get().user?.uid;
    if (!uid || !provider) return null;
    try {
      return await loadPromptsFromFirestore(uid, provider);
    } catch (e) {
      console.error("Cloud load prompts error:", e);
      return null;
    }
  },

  async saveTranslationSettings(provider, settings) {
    const uid = get().user?.uid;
    if (!uid || !provider) return false;
    try {
      await saveTranslationSettingsToFirestore(uid, provider, settings);
      return true;
    } catch (e) {
      console.error("Cloud save translation settings error:", e);
      return false;
    }
  },

  async loadTranslationSettings() {
    const uid = get().user?.uid;
    if (!uid) return null;
    try {
      return await loadTranslationSettingsFromFirestore(uid);
    } catch (e) {
      console.error("Cloud load translation settings error:", e);
      return null;
    }
  },
}));
