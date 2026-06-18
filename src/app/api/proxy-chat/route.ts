import { NextRequest, NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: CORS_HEADERS });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid proxy payload", 400);
  }

  const provider = String(body.provider ?? "").trim();
  const baseUrl = String(body.baseUrl ?? "")
    .trim()
    .replace(/\/$/, "");
  const payload = body.payload;
  const apiKey = String(body.apiKey ?? "").trim();

  if (!provider || !baseUrl || !payload || typeof payload !== "object") {
    return jsonError("Invalid proxy payload", 400);
  }
  if (provider !== "ollama" && !apiKey) {
    return jsonError("Missing apiKey", 400);
  }

  const targetUrl = provider === "ollama" ? `${baseUrl}/api/chat` : `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider !== "ollama") headers.Authorization = `Bearer ${apiKey}`;

  try {
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text || "{}");
    } catch {
      parsed = { raw: text };
    }

    return NextResponse.json(parsed, { status: upstream.status, headers: CORS_HEADERS });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Proxy request failed", 500);
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
