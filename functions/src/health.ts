// functions/src/health.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

interface HealthCheck {
  status: "pass" | "fail";
  latencyMs: number;
  error?: string;
}

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  checks: {
    firestore: HealthCheck;
    paystack: HealthCheck;
  };
}

/**
 * Check Firestore connectivity
 */
async function checkFirestore(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    // Try to read a non-existent document (lightweight operation)
    await db.collection("_health").doc("ping").get();
    return { status: "pass", latencyMs: Date.now() - start };
  } catch (error: any) {
    return {
      status: "fail",
      latencyMs: Date.now() - start,
      error: error.message || "Firestore connection failed",
    };
  }
}

/**
 * Check Paystack API connectivity
 */
async function checkPaystack(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const PAYSTACK_URI = process.env.PAYSTACK_URI || "https://api.paystack.co";
    const response = await fetch(`${PAYSTACK_URI}/bank?country=nigeria&perPage=1`, {
      headers: {
        Authorization: `Bearer ${paystackSecret.value()}`,
      },
    });

    if (response.ok) {
      return { status: "pass", latencyMs: Date.now() - start };
    } else {
      return {
        status: "fail",
        latencyMs: Date.now() - start,
        error: `Paystack returned ${response.status}`,
      };
    }
  } catch (error: any) {
    return {
      status: "fail",
      latencyMs: Date.now() - start,
      error: error.message || "Paystack connection failed",
    };
  }
}

/**
 * Public health check endpoint
 * Returns status of core dependencies
 */
export const healthCheck = onRequest(
  { region: "europe-west1", secrets: [paystackSecret] },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      const [firestoreCheck, paystackCheck] = await Promise.all([
        checkFirestore(),
        checkPaystack(),
      ]);

      const checks = {
        firestore: firestoreCheck,
        paystack: paystackCheck,
      };

      const allPassing = Object.values(checks).every((c) => c.status === "pass");
      const somePassing = Object.values(checks).some((c) => c.status === "pass");

      const status: HealthStatus = {
        status: allPassing ? "healthy" : somePassing ? "degraded" : "unhealthy",
        timestamp: new Date().toISOString(),
        version: process.env.FUNCTION_VERSION || "1.0.0",
        checks,
      };

      const httpStatus = allPassing ? 200 : somePassing ? 200 : 503;

      logger.info("Health check completed", { status: status.status, checks });
      res.status(httpStatus).json(status);
    } catch (error) {
      logger.error("Health check error", error);
      res.status(503).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        version: process.env.FUNCTION_VERSION || "1.0.0",
        checks: {
          firestore: { status: "fail", latencyMs: 0, error: "Check failed" },
          paystack: { status: "fail", latencyMs: 0, error: "Check failed" },
        },
      });
    }
  }
);

/**
 * Deep health check with more details (requires authentication)
 */
export const healthCheckDeep = onRequest(
  { region: "europe-west1", secrets: [paystackSecret] },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    // Check for admin header (simple protection)
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_HEALTH_KEY && process.env.ENV_TYPE === "production") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const [firestoreCheck, paystackCheck] = await Promise.all([
        checkFirestore(),
        checkPaystack(),
      ]);

      // Get collection counts
      const [donorsCount, orphanagesCount, donationsCount, recurringPlansCount] =
        await Promise.all([
          db.collection("donors").count().get().then((s) => s.data().count),
          db.collection("orphanages").count().get().then((s) => s.data().count),
          db.collection("donations").count().get().then((s) => s.data().count),
          db.collection("recurringPlans").count().get().then((s) => s.data().count),
        ]);

      res.json({
        status: firestoreCheck.status === "pass" && paystackCheck.status === "pass"
          ? "healthy"
          : "degraded",
        timestamp: new Date().toISOString(),
        version: process.env.FUNCTION_VERSION || "1.0.0",
        checks: {
          firestore: firestoreCheck,
          paystack: paystackCheck,
        },
        collections: {
          donors: { count: donorsCount },
          orphanages: { count: orphanagesCount },
          donations: { count: donationsCount },
          recurringPlans: { count: recurringPlansCount },
        },
        environment: {
          region: "europe-west1",
          nodeVersion: process.version,
        },
      });
    } catch (error) {
      logger.error("Deep health check error", error);
      res.status(500).json({ error: "Health check failed" });
    }
  }
);
