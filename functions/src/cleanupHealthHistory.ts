// functions/src/cleanupHealthHistory.ts
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { Timestamp } from "firebase-admin/firestore";

const RETENTION_DAYS = 90;
const BATCH_SIZE = 500; // Firestore batch limit

/**
 * Daily cleanup function to remove old health check history records
 * Removes records older than 90 days to control storage costs
 */
export const cleanupHealthHistory = onSchedule(
  {
    schedule: "every day 03:00", // Run daily at 3 AM Lagos time
    timeZone: "Africa/Lagos",
    region: "europe-west1",
  },
  async () => {
    const now = new Date();
    logger.info(`cleanupHealthHistory triggered at ${now.toISOString()}`);

    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const cutoffTimestamp = Timestamp.fromDate(cutoffDate);

    let totalDeleted = 0;
    let batchCount = 0;

    try {
      // Delete in batches to avoid timeout and memory issues
      let hasMore = true;

      while (hasMore) {
        const snapshot = await db
          .collection("healthCheckHistory")
          .where("timestamp", "<", cutoffTimestamp)
          .limit(BATCH_SIZE)
          .get();

        if (snapshot.empty) {
          hasMore = false;
          break;
        }

        const batch = db.batch();
        snapshot.docs.forEach((doc) => {
          batch.delete(doc.ref);
        });

        await batch.commit();
        totalDeleted += snapshot.size;
        batchCount++;

        logger.info(`Deleted batch ${batchCount}: ${snapshot.size} records`);

        // If we got fewer than BATCH_SIZE, we're done
        if (snapshot.size < BATCH_SIZE) {
          hasMore = false;
        }
      }

      logger.info(`Health history cleanup completed: ${totalDeleted} records deleted in ${batchCount} batches`);
    } catch (error) {
      logger.error("Health history cleanup failed", error);
      throw error;
    }
  }
);
