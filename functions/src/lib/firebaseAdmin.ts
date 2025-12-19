// firebaseAdmin.ts
import * as admin from "firebase-admin";
import { getApps } from "firebase-admin/app";

// Initialize only once
if (!getApps().length) {
  admin.initializeApp();
}

// Export commonly used services
export const db = admin.firestore();
export const auth = admin.auth();
export const messaging = admin.messaging();

// Optional: export full admin instance if needed elsewhere
export default admin;
