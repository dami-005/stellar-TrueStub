import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { env } from "../config/env";

const normalizedPrivateKey = env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, "\n").trim();
const shouldInitializeFirebase =
  env.NODE_ENV !== "test" && normalizedPrivateKey.includes("BEGIN ") && normalizedPrivateKey.includes("PRIVATE KEY");

const app =
  getApps().length
    ? getApps()[0]
    : shouldInitializeFirebase
      ? initializeApp({
          credential: cert({
            projectId: env.FIREBASE_ADMIN_PROJECT_ID,
            clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
            privateKey: normalizedPrivateKey,
          }),
        })
      : initializeApp({ projectId: env.FIREBASE_ADMIN_PROJECT_ID });

export const firebaseAuth = shouldInitializeFirebase
  ? getAuth(app)
  : ({
      verifyIdToken: async () => {
        throw new Error("Firebase Admin is disabled in test mode");
      },
      getUser: async () => {
        throw new Error("Firebase Admin is disabled in test mode");
      },
      deleteUser: async () => {
        throw new Error("Firebase Admin is disabled in test mode");
      },
    } as any);
