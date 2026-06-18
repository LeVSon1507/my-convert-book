import { NextResponse } from "next/server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

export function GET() {
  return NextResponse.json(
    {
      apiKey: process.env.FIREBASE_API_KEY || "",
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
      projectId: process.env.FIREBASE_PROJECT_ID || "",
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
      appId: process.env.FIREBASE_APP_ID || "",
    },
    { headers: CORS_HEADERS },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: CORS_HEADERS });
}
