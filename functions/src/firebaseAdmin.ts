// firebaseAdmin.ts
import { initializeApp, getApps, getApp } from "firebase-admin/app";

if (!getApps().length) {
  initializeApp();
}

export { getAuth } from "firebase-admin/auth";
export { getMessaging } from "firebase-admin/messaging";
