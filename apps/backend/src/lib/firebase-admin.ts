import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";

const app = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: cert({
        projectId: env.FIREBASE_ADMIN_PROJECT_ID,
        clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
        // Service-account keys are usually stored in env files with literal
        // "\n" sequences instead of real newlines — un-escape them here.
        privateKey: env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });

export const firebaseAuth = getAuth(app);

/**
 * Express middleware that verifies a Firebase ID token from the
 * `Authorization: Bearer <token>` header and attaches the authenticated
 * user's id to `res.locals.userId`. Requests without a valid token are
 * rejected with 401 so routes can never act on a client-supplied userId.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : undefined;

  if (!token) {
    res.status(401).json({ error: "Missing authentication token" });
    return;
  }

  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    res.locals.userId = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid authentication token" });
  }
}
