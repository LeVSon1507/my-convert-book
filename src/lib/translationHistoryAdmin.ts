import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";

/**
 * Admin-SDK mirror of saveTranslation()/writeLargeTextSubcollection() in
 * src/lib/firebase.ts. A completed backend job writes into the exact same
 * `users/{uid}/translations/{docId}` shape (including the chunked large-text
 * subcollection, to dodge Firestore's 1MiB doc cap) so HistoryWorkspace.tsx's
 * existing client-SDK reads pick it up with no changes on that side.
 */

const FIRESTORE_CHUNK_SIZE = 600000;

function splitIntoFirestoreChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += FIRESTORE_CHUNK_SIZE) {
    chunks.push(text.slice(i, i + FIRESTORE_CHUNK_SIZE));
  }
  return chunks.length ? chunks : [""];
}

export type SaveTranslationServerParams = {
  fileName: string;
  model: string;
  provider: string;
  totalChunks: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
};

export async function saveTranslationServer(
  uid: string,
  translatedText: string,
  params: SaveTranslationServerParams,
): Promise<string> {
  const db = getAdminDb();
  const docRef = db.collection("users").doc(uid).collection("translations").doc();

  const textChunks = splitIntoFirestoreChunks(translatedText);
  const bulkWriter = db.bulkWriter();
  textChunks.forEach((chunk, idx) => {
    bulkWriter.set(docRef.collection("chunks").doc(String(idx)), { text: chunk });
  });
  await bulkWriter.close();

  await docRef.set({
    fileName: params.fileName || "unknown.txt",
    completedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    charCount: translatedText.length,
    model: params.model,
    provider: params.provider,
    totalChunks: params.totalChunks,
    completedChunks: params.totalChunks,
    status: "completed",
    textChunkCount: textChunks.length,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    cost: params.cost,
  });

  return docRef.id;
}
