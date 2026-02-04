// functions/src/getSlaMetrics.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { SLASummary } from "./updateSlaSummary";

type WindowType = "24h" | "7d" | "30d" | "90d";

const VALID_WINDOWS: WindowType[] = ["24h", "7d", "30d", "90d"];

/**
 * Get SLA metrics for a specific time window
 * GET /getSlaMetrics?window=24h
 *
 * Query params:
 * - window: "24h" | "7d" | "30d" | "90d" (default: "24h")
 */
export const getSlaMetrics = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    // Check for admin header (same pattern as healthCheckDeep)
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_HEALTH_KEY && process.env.ENV_TYPE === "production") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const windowParam = (req.query.window as string) || "24h";

      // Validate window parameter
      if (!VALID_WINDOWS.includes(windowParam as WindowType)) {
        res.status(400).json({
          error: `Invalid window parameter. Must be one of: ${VALID_WINDOWS.join(", ")}`,
        });
        return;
      }

      const windowType = windowParam as WindowType;

      // Fetch the SLA summary for the requested window
      const doc = await db.collection("slaSummary").doc(windowType).get();

      if (!doc.exists) {
        res.status(200).json({
          windowType,
          message: "No SLA data available yet. Data will be populated after the first scheduled check.",
          lastUpdated: null,
          totalChecks: 0,
          infrastructure: {
            firestore: { passCount: 0, failCount: 0, uptimePercentage: 0, avgLatencyMs: 0, maxLatencyMs: 0 },
            paystack: { passCount: 0, failCount: 0, uptimePercentage: 0, avgLatencyMs: 0, maxLatencyMs: 0 },
          },
          endpoints: {},
          overallUptimePercentage: 0,
        });
        return;
      }

      const data = doc.data() as SLASummary;

      // Convert Timestamp to ISO string for JSON response
      res.status(200).json({
        windowType: data.windowType,
        lastUpdated: data.lastUpdated?.toDate().toISOString() || null,
        totalChecks: data.totalChecks,
        infrastructure: data.infrastructure,
        endpoints: data.endpoints,
        overallUptimePercentage: data.overallUptimePercentage,
      });

      logger.info("SLA metrics retrieved", { windowType });
    } catch (error) {
      logger.error("Error fetching SLA metrics", error);
      res.status(500).json({ error: "Failed to fetch SLA metrics" });
    }
  }
);

/**
 * Get all SLA metrics for all time windows
 * GET /getAllSlaMetrics
 */
export const getAllSlaMetrics = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    // Check for admin header
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_HEALTH_KEY && process.env.ENV_TYPE === "production") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const snapshot = await db.collection("slaSummary").get();

      const metrics: Record<string, unknown> = {};

      for (const doc of snapshot.docs) {
        const data = doc.data() as SLASummary;
        metrics[doc.id] = {
          windowType: data.windowType,
          lastUpdated: data.lastUpdated?.toDate().toISOString() || null,
          totalChecks: data.totalChecks,
          infrastructure: data.infrastructure,
          endpoints: data.endpoints,
          overallUptimePercentage: data.overallUptimePercentage,
        };
      }

      res.status(200).json({
        metrics,
        availableWindows: VALID_WINDOWS,
      });

      logger.info("All SLA metrics retrieved");
    } catch (error) {
      logger.error("Error fetching all SLA metrics", error);
      res.status(500).json({ error: "Failed to fetch SLA metrics" });
    }
  }
);
