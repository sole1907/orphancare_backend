// functions/src/updateSlaSummary.ts
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { Timestamp, FieldValue } from "firebase-admin/firestore";

export interface ServiceSLAStats {
  passCount: number;
  failCount: number;
  uptimePercentage: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

export interface SLASummary {
  windowType: "24h" | "7d" | "30d" | "90d";
  lastUpdated: Timestamp;
  totalChecks: number;
  infrastructure: {
    firestore: ServiceSLAStats;
    paystack: ServiceSLAStats;
  };
  endpoints: Record<string, ServiceSLAStats>;
  overallUptimePercentage: number;
}

type WindowType = "24h" | "7d" | "30d" | "90d";

const WINDOW_HOURS: Record<WindowType, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  "90d": 24 * 90,
};

/**
 * Calculate SLA stats for a single service from check results
 */
function calculateServiceStats(
  checks: Array<{ status: "pass" | "fail"; latencyMs: number }>
): ServiceSLAStats {
  if (checks.length === 0) {
    return {
      passCount: 0,
      failCount: 0,
      uptimePercentage: 0,
      avgLatencyMs: 0,
      maxLatencyMs: 0,
    };
  }

  const passCount = checks.filter((c) => c.status === "pass").length;
  const failCount = checks.filter((c) => c.status === "fail").length;
  const latencies = checks.map((c) => c.latencyMs).filter((l) => l > 0);

  return {
    passCount,
    failCount,
    uptimePercentage: passCount / checks.length * 100,
    avgLatencyMs: latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0,
    maxLatencyMs: latencies.length > 0 ? Math.max(...latencies) : 0,
  };
}

/**
 * Calculate SLA summary for a specific time window
 */
async function calculateSummaryForWindow(windowType: WindowType): Promise<SLASummary | null> {
  const hoursAgo = WINDOW_HOURS[windowType];
  const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

  try {
    const snapshot = await db
      .collection("healthCheckHistory")
      .where("timestamp", ">=", Timestamp.fromDate(cutoffTime))
      .orderBy("timestamp", "desc")
      .get();

    if (snapshot.empty) {
      logger.info(`No health check records found for window ${windowType}`);
      return null;
    }

    // Collect all check results
    const firestoreChecks: Array<{ status: "pass" | "fail"; latencyMs: number }> = [];
    const paystackChecks: Array<{ status: "pass" | "fail"; latencyMs: number }> = [];
    const endpointChecks: Record<string, Array<{ status: "pass" | "fail"; latencyMs: number }>> = {};

    for (const doc of snapshot.docs) {
      const data = doc.data();

      // Infrastructure checks
      if (data.infrastructure?.firestore) {
        firestoreChecks.push({
          status: data.infrastructure.firestore.status,
          latencyMs: data.infrastructure.firestore.latencyMs || 0,
        });
      }
      if (data.infrastructure?.paystack) {
        paystackChecks.push({
          status: data.infrastructure.paystack.status,
          latencyMs: data.infrastructure.paystack.latencyMs || 0,
        });
      }

      // Endpoint checks
      if (data.endpoints) {
        for (const [name, check] of Object.entries(data.endpoints)) {
          const checkData = check as { status: "pass" | "fail"; latencyMs: number; error?: string };
          // Skip "Skipped" entries
          if (checkData.error?.includes("Skipped")) continue;

          if (!endpointChecks[name]) {
            endpointChecks[name] = [];
          }
          endpointChecks[name].push({
            status: checkData.status,
            latencyMs: checkData.latencyMs || 0,
          });
        }
      }
    }

    // Calculate stats
    const firestoreStats = calculateServiceStats(firestoreChecks);
    const paystackStats = calculateServiceStats(paystackChecks);

    const endpointStats: Record<string, ServiceSLAStats> = {};
    for (const [name, checks] of Object.entries(endpointChecks)) {
      endpointStats[name] = calculateServiceStats(checks);
    }

    // Calculate overall uptime
    const allUptimes = [
      firestoreStats.uptimePercentage,
      paystackStats.uptimePercentage,
      ...Object.values(endpointStats).map((s) => s.uptimePercentage),
    ].filter((u) => u > 0);

    const overallUptimePercentage = allUptimes.length > 0
      ? Math.round((allUptimes.reduce((a, b) => a + b, 0) / allUptimes.length) * 100) / 100
      : 0;

    return {
      windowType,
      lastUpdated: Timestamp.now(),
      totalChecks: snapshot.size,
      infrastructure: {
        firestore: firestoreStats,
        paystack: paystackStats,
      },
      endpoints: endpointStats,
      overallUptimePercentage,
    };
  } catch (error) {
    logger.error(`Error calculating SLA summary for window ${windowType}`, error);
    return null;
  }
}

/**
 * Scheduled function to update SLA summaries
 * Runs every hour to calculate uptime percentages for all time windows
 */
export const updateSlaSummary = onSchedule(
  {
    schedule: "every 60 minutes",
    timeZone: "Africa/Lagos",
    region: "europe-west1",
  },
  async () => {
    const now = new Date();
    logger.info(`updateSlaSummary triggered at ${now.toISOString()}`);

    const windows: WindowType[] = ["24h", "7d", "30d", "90d"];

    try {
      const batch = db.batch();
      let updatedCount = 0;

      for (const windowType of windows) {
        const summary = await calculateSummaryForWindow(windowType);
        if (summary) {
          const docRef = db.collection("slaSummary").doc(windowType);
          batch.set(docRef, summary);
          updatedCount++;
        }
      }

      if (updatedCount > 0) {
        await batch.commit();
        logger.info(`SLA summaries updated for ${updatedCount} windows`);
      } else {
        logger.info("No SLA summaries to update");
      }
    } catch (error) {
      logger.error("Failed to update SLA summaries", error);
      throw error;
    }
  }
);
