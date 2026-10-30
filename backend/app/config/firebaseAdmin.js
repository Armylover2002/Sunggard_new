import dotenv from "dotenv";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

let firebaseAdminApp = null;

/**
 * Returns a firebase-admin app when FIREBASE_SERVICE_ACCOUNT (JSON string or file path),
 * FIREBASE_SERVICE_ACCOUNT_PATH, or serviceAccountKey.json is available.
 * FIREBASE_DATABASE_URL is optional (defaults to https://<projectId>-default-rtdb.firebaseio.com).
 */
export const getFirebaseAdminApp = () => {
  if (firebaseAdminApp) return firebaseAdminApp;
  if (admin.apps.length > 0) {
    firebaseAdminApp = admin.app();
    return firebaseAdminApp;
  }

  const jsonOrPath = process.env.FIREBASE_SERVICE_ACCOUNT;
  const explicitPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  let serviceAccount = null;

  // 1. Try FIREBASE_SERVICE_ACCOUNT (inline JSON or file path)
  if (jsonOrPath) {
    const trimmed = jsonOrPath.trim();
    if (trimmed.startsWith("{")) {
      try {
        serviceAccount = JSON.parse(trimmed);
      } catch (e) {
        console.warn("[Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", e.message);
      }
    } else {
      const resolvedPath = path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(__dirname, "../../", trimmed);
      if (fs.existsSync(resolvedPath)) {
        try {
          serviceAccount = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
        } catch (e) {
          console.warn("[Firebase] Failed to read FIREBASE_SERVICE_ACCOUNT file:", e.message);
        }
      }
    }
  }

  // 2. Try FIREBASE_SERVICE_ACCOUNT_PATH
  if (!serviceAccount && explicitPath) {
    const resolvedPath = path.isAbsolute(explicitPath)
      ? explicitPath
      : path.resolve(__dirname, "../../", explicitPath);
    if (fs.existsSync(resolvedPath)) {
      try {
        serviceAccount = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
      } catch (e) {
        console.warn("[Firebase] Failed to read FIREBASE_SERVICE_ACCOUNT_PATH:", e.message);
      }
    }
  }

  // 3. Fallback to default serviceAccountKey.json in backend directory
  if (!serviceAccount) {
    const defaultKeyPath = path.resolve(__dirname, "../../serviceAccountKey.json");
    if (fs.existsSync(defaultKeyPath)) {
      try {
        serviceAccount = JSON.parse(fs.readFileSync(defaultKeyPath, "utf8"));
      } catch (e) {
        console.warn("[Firebase] Failed to read default serviceAccountKey.json:", e.message);
      }
    }
  }

  if (!serviceAccount) {
    return null;
  }

  try {
    const targetDatabaseURL =
      databaseURL ||
      (serviceAccount.project_id
        ? `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
        : undefined);

    const config = {
      credential: admin.credential.cert(serviceAccount),
    };
    if (targetDatabaseURL) {
      config.databaseURL = targetDatabaseURL;
    }

    firebaseAdminApp = admin.initializeApp(config);
    return firebaseAdminApp;
  } catch (e) {
    console.warn("[Firebase] Init skipped:", e.message);
    return null;
  }
};

export const getFirebaseRealtimeDb = () => {
  const app = getFirebaseAdminApp();
  if (!app) return null;
  return admin.database(app);
};
