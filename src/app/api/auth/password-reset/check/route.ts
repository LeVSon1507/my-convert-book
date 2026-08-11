import { NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebaseAdmin";

type PasswordResetCheckBody = {
  email?: unknown;
};

function normalizeEmailAddress(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase();
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

function buildJsonError(status: number, code: string, error: string) {
  return NextResponse.json({ code, error }, { status });
}

export async function POST(request: Request) {
  let body: PasswordResetCheckBody;

  try {
    body = await request.json();
  } catch {
    return buildJsonError(400, "auth/invalid-request", "Payload không hợp lệ.");
  }

  const normalizedEmail = normalizeEmailAddress(body.email);
  if (!isEmailLike(normalizedEmail)) {
    return buildJsonError(400, "auth/invalid-email", "Email không hợp lệ.");
  }

  try {
    const adminAuth = getAdminAuth();
    const userRecord = await adminAuth.getUserByEmail(normalizedEmail);
    const hasPasswordProvider = userRecord.providerData.some(
      (providerProfile) => providerProfile.providerId === "password",
    );

    if (!hasPasswordProvider) {
      return buildJsonError(
        400,
        "auth/no-password-provider",
        "Email này đang dùng đăng nhập Google, không có mật khẩu để đặt lại.",
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;

    if (code === "auth/user-not-found") {
      return buildJsonError(404, "auth/user-not-found", "Email không tồn tại.");
    }

    console.error("[password-reset-check] Failed to verify email", error);
    return buildJsonError(
      500,
      "auth/password-reset-check-failed",
      "Không thể kiểm tra email lúc này. Vui lòng thử lại sau.",
    );
  }
}
