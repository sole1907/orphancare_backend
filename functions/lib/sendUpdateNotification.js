"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendUpdateNotification = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const logger = __importStar(require("firebase-functions/logger"));
const firebaseAdmin_1 = require("./lib/firebaseAdmin");
exports.sendUpdateNotification = (0, firestore_1.onDocumentCreated)({
    region: "europe-west1",
    document: "updates/{updateId}",
}, async (event) => {
    const update = event.data?.data();
    if (!update)
        return;
    const updateId = event.params.updateId;
    const orphanageId = update.orphanageId;
    const childId = update.childId || null;
    const orphanageName = update.orphanageName || "An orphanage";
    logger.info(`sendUpdateNotification triggered for update ${updateId}, orphanage ${orphanageId}, child ${childId}`);
    try {
        // Collect donor UIDs who should receive this notification
        const donorUids = new Set();
        // Calculate 12 months ago for donation queries
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        if (childId) {
            // Child-specific update: notify donors who follow this child or donated to this child
            // 1. Get donors who follow this child
            const followsSnapshot = await firebaseAdmin_1.db
                .collectionGroup("follows")
                .where("childId", "==", childId)
                .get();
            // Extract donorIds from document paths
            // The document path is donor_follows/{donorId}/follows/{childId}
            followsSnapshot.docs.forEach((doc) => {
                const pathParts = doc.ref.path.split("/");
                if (pathParts.length === 4 && pathParts[0] === "donor_follows") {
                    donorUids.add(pathParts[1]); // donorId
                }
            });
            // 2. Get donors who donated to this child in last 12 months
            const donationsSnapshot = await firebaseAdmin_1.db
                .collection("donations")
                .where("childId", "==", childId)
                .where("createdAt", ">=", twelveMonthsAgo)
                .where("status", "==", "success")
                .get();
            donationsSnapshot.docs.forEach((doc) => {
                const donorUid = doc.data().donorUid;
                if (donorUid)
                    donorUids.add(donorUid);
            });
        }
        else {
            // Orphanage-level update: notify donors who donated to this orphanage
            const donationsSnapshot = await firebaseAdmin_1.db
                .collection("donations")
                .where("orphanageId", "==", orphanageId)
                .where("createdAt", ">=", twelveMonthsAgo)
                .where("status", "==", "success")
                .get();
            donationsSnapshot.docs.forEach((doc) => {
                const donorUid = doc.data().donorUid;
                if (donorUid)
                    donorUids.add(donorUid);
            });
        }
        logger.info(`Found ${donorUids.size} donors to notify`);
        if (donorUids.size === 0) {
            logger.info("No donors to notify, skipping");
            return;
        }
        // Get FCM tokens for these donors
        const donorUidArray = Array.from(donorUids);
        const fcmTokens = [];
        // Process in batches of 30 (Firestore "in" query limit)
        for (let i = 0; i < donorUidArray.length; i += 30) {
            const batch = donorUidArray.slice(i, i + 30);
            const donorsSnapshot = await firebaseAdmin_1.db
                .collection("donors")
                .where("__name__", "in", batch.map((uid) => uid))
                .get();
            donorsSnapshot.docs.forEach((doc) => {
                const data = doc.data();
                const fcmToken = data.fcmToken;
                // Check if push notifications are enabled (default true for existing donors)
                const pushEnabled = data.pushNotificationsEnabled !== false;
                if (fcmToken && pushEnabled) {
                    fcmTokens.push(fcmToken);
                }
            });
        }
        logger.info(`Found ${fcmTokens.length} FCM tokens`);
        if (fcmTokens.length === 0) {
            logger.info("No FCM tokens found, skipping");
            return;
        }
        // Send multicast notification
        const message = {
            notification: {
                title: `New update from ${orphanageName}`,
                body: update.title || update.body?.slice(0, 100) + "...",
            },
            data: {
                type: "update",
                updateId: updateId,
                ...(childId && { childId: childId }),
            },
            tokens: fcmTokens,
        };
        const response = await firebaseAdmin_1.messaging.sendEachForMulticast(message);
        logger.info(`Notifications sent: ${response.successCount} success, ${response.failureCount} failed`);
        // Optionally clean up invalid tokens
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    failedTokens.push(fcmTokens[idx]);
                    logger.warn(`Failed to send to token: ${resp.error?.message}`);
                }
            });
            // Could update donors collection to remove invalid tokens here
        }
    }
    catch (error) {
        logger.error("sendUpdateNotification error", error);
    }
});
