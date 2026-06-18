import { create } from "zustand";
import {
  TranslationHistoryEntry,
  firebaseAuthMessage,
  initFirebase,
  loadAccountCustomModels,
  loadCloudHistory,
  rememberCustomModelForAccount,
  saveApiKey as saveApiKeyToFirestore,
  loadApiKey as loadApiKeyFromFirestore,
  savePrompts as savePromptsToFirestore,
  loadPrompts as loadPromptsFromFirestore,
  ProviderPrompts,
  signIn,
  signOutUser,
  signUp,
  subscribeToAuthChanges,
} from "@/lib/firebase";

export type CloudUser = { uid: string; email: string | null };

type AuthState = {
  bootstrapped: boolean;
  user: CloudUser | null;
  authError: string;
  authPending: boolean;
  customModelsByProvider: Record<string, string[]>;
  cloudHistory: TranslationHistoryEntry[];

  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<boolean>;
  register: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  rememberCustomModel: (provider: string, modelId: string) => Promise<void>;
  refreshCloudHistory: () => Promise<void>;
  saveApiKey: (provider: string, apiKey: string) => Promise<boolean>;
  loadApiKey: (provider: string) => Promise<string>;
  savePrompts: (provider: string, prompts: ProviderPrompts) => Promise<boolean>;
  loadPrompts: (provider: string) => Promise<ProviderPrompts | null>;
};

async function syncUserData(
  uid: string,
  set: (partial: Partial<AuthState>) => void,
): Promise<void> {
  const [customModelsByProvider, cloudHistory] = await Promise.all([
    loadAccountCustomModels(uid),
    loadCloudHistory(uid),
  ]);
  set({ customModelsByProvider, cloudHistory });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  bootstrapped: false,
  user: null,
  authError: "",
  authPending: false,
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
        set({ user: null, customModelsByProvider: {}, cloudHistory: [] });
        return;
      }
      const user = { uid: firebaseUser.uid, email: firebaseUser.email };
      set({ user });
      syncUserData(user.uid, set).catch((e) =>
        console.error("Cloud sync error:", e),
      );
    });
  },

  async login(email, password) {
    set({ authError: "", authPending: true });
    try {
      await signIn(email, password);
      return true;
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "unknown";
      set({ authError: firebaseAuthMessage(code) });
      return false;
    } finally {
      set({ authPending: false });
    }
  },

  async register(email, password) {
    set({ authError: "", authPending: true });
    try {
      await signUp(email, password);
      return true;
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "unknown";
      set({ authError: firebaseAuthMessage(code) });
      return false;
    } finally {
      set({ authPending: false });
    }
  },

  async logout() {
    await signOutUser();
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
      customModelsByProvider: { ...get().customModelsByProvider, [provider]: optimisticList },
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
        customModelsByProvider: { ...get().customModelsByProvider, [provider]: persistedList },
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
}));
