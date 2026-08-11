import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

export function GET() {
  return NextResponse.json(
    {
      defaultProvider: process.env.DEFAULT_PROVIDER || "openrouter",
      defaultModel: process.env.DEFAULT_MODEL || "x-ai/grok-4.3",
      keys: {
        openrouter: process.env.OPENROUTER_API_KEY || "",
        openai: process.env.OPENAI_API_KEY || "",
        gemini: process.env.GEMINI_API_KEY || "",
        grok: process.env.XAI_API_KEY || "",
        huggingface: process.env.HUGGINGFACE_API_KEY || "",
      },
    },
    { headers: CORS_HEADERS },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}
