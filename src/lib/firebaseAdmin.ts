import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Server-only Firebase Admin singleton. Never import this from client components —
 * it reads a private service-account key from env and bypasses Firestore security
 * rules entirely, so every caller must do its own authorization (see routes under
 * src/app/api/translate/jobs).
 */

function buildAdminApp(): App {
  if (getApps().length) return getApps()[0];

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase Admin credentials (FIREBASE_PROJECT_ID / FIREBASE_ADMIN_CLIENT_EMAIL / FIREBASE_ADMIN_PRIVATE_KEY).",
    );
  }

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

let dbInstance: Firestore | null = null;

export function getAdminDb(): Firestore {
  if (!dbInstance) dbInstance = getFirestore(buildAdminApp());
  return dbInstance;
}

export async function verifyIdToken(idToken: string): Promise<string> {
  const decoded = await getAuth(buildAdminApp()).verifyIdToken(idToken);
  return decoded.uid;
}

export function getUidFromAuthHeader(
  request: Request,
): Promise<string | null> {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return Promise.resolve(null);
  return verifyIdToken(token).catch(() => null);
}
