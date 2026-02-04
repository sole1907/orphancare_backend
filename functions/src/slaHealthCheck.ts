// functions/src/slaHealthCheck.ts
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import { Timestamp } from "firebase-admin/firestore";
import { SlaEndpoint, SlaConfigData } from "./slaConfig";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

interface ServiceCheckResult {
  status: "pass" | "fail";
  latencyMs: number;
  error?: string;
}

interface EndpointCheckResult extends ServiceCheckResult {
  httpStatus?: number;
}

interface HealthCheckHistoryRecord {
  timestamp: Timestamp;
  overallStatus: "healthy" | "degraded" | "unhealthy";
  infrastructure: {
    firestore: ServiceCheckResult;
    paystack: ServiceCheckResult;
  };
  endpoints: Record<string, EndpointCheckResult>;
}

const CONFIG_DOC_PATH = "_config/slaEndpoints";

/**
 * Check Firestore connectivity
 */
async function checkFirestore(): Promise<ServiceCheckResult> {
  const start = Date.now();
  try {
    await db.collection("_health").doc("ping").get();
    return { status: "pass", latencyMs: Date.now() - start };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Firestore connection failed";
    return {
      status: "fail",
      latencyMs: Date.now() - start,
      error: errorMessage,
    };
  }
}

/**
 * Check Paystack API connectivity
 */
async function checkPaystack(): Promise<ServiceCheckResult> {
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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Paystack connection failed";
    return {
      status: "fail",
      latencyMs: Date.now() - start,
      error: errorMessage,
    };
  }
}

/**
 * Check a configured endpoint
 */
async function checkEndpoint(endpoint: SlaEndpoint): Promise<EndpointCheckResult> {
  // Skip endpoints that require authentication for now
  if (endpoint.requiresAuth) {
    return {
      status: "pass",
      latencyMs: 0,
      httpStatus: 0,
      error: "Skipped - requires authentication",
    };
  }

  const start = Date.now();
  const baseUrl = process.env.FUNCTIONS_BASE_URL || "https://europe-west1-orphancare-93b41.cloudfunctions.net";

  try {
    const fetchOptions: RequestInit = {
      method: endpoint.method,
      headers: {
        "Content-Type": "application/json",
      },
    };

    // Add body for POST/PUT requests if testPayload is provided
    if ((endpoint.method === "POST" || endpoint.method === "PUT") && endpoint.testPayload) {
      fetchOptions.body = JSON.stringify(endpoint.testPayload);
    }

    const response = await fetch(`${baseUrl}${endpoint.path}`, fetchOptions);
    const latencyMs = Date.now() - start;

    // Consider 2xx and 3xx as passing
    if (response.ok || (response.status >= 200 && response.status < 400)) {
      return {
        status: "pass",
        latencyMs,
        httpStatus: response.status,
      };
    } else {
      return {
        status: "fail",
        latencyMs,
        httpStatus: response.status,
        error: `Endpoint returned ${response.status}`,
      };
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Endpoint check failed";
    return {
      status: "fail",
      latencyMs: Date.now() - start,
      error: errorMessage,
    };
  }
}

/**
 * Get the configured SLA endpoints from Firestore
 */
async function getSlaEndpoints(): Promise<SlaEndpoint[]> {
  try {
    const doc = await db.doc(CONFIG_DOC_PATH).get();
    if (!doc.exists) {
      // Return default endpoint if not configured
      return [{ name: "healthCheck", path: "/healthCheck", method: "GET" }];
    }
    const data = doc.data() as SlaConfigData;
    return data.endpoints || [];
  } catch (error) {
    logger.error("Error fetching SLA endpoints config", error);
    return [{ name: "healthCheck", path: "/healthCheck", method: "GET" }];
  }
}

/**
 * Scheduled SLA health check function
 * Default: runs every 60 minutes (configurable via SLA_CHECK_SCHEDULE env var)
 */
export const slaHealthCheck = onSchedule(
  {
    schedule: process.env.SLA_CHECK_SCHEDULE || "every 60 minutes",
    timeZone: "Africa/Lagos",
    region: "europe-west1",
    secrets: [paystackSecret],
  },
  async () => {
    const now = new Date();
    logger.info(`slaHealthCheck triggered at ${now.toISOString()}`);

    try {
      // Fetch configured endpoints
      const endpoints = await getSlaEndpoints();

      // Run infrastructure checks in parallel
      const [firestoreCheck, paystackCheck] = await Promise.all([
        checkFirestore(),
        checkPaystack(),
      ]);

      // Run endpoint checks in parallel
      const endpointResults: Record<string, EndpointCheckResult> = {};
      const endpointChecks = await Promise.all(
        endpoints.map(async (endpoint) => {
          const result = await checkEndpoint(endpoint);
          return { name: endpoint.name, result };
        })
      );

      for (const { name, result } of endpointChecks) {
        endpointResults[name] = result;
      }

      // Determine overall status
      const infraChecks = [firestoreCheck, paystackCheck];
      const allEndpointResults = Object.values(endpointResults).filter(
        (r) => !r.error?.includes("Skipped")
      );

      const allInfraPassing = infraChecks.every((c) => c.status === "pass");
      const someInfraPassing = infraChecks.some((c) => c.status === "pass");
      const allEndpointsPassing = allEndpointResults.length === 0 ||
        allEndpointResults.every((c) => c.status === "pass");

      let overallStatus: "healthy" | "degraded" | "unhealthy";
      if (allInfraPassing && allEndpointsPassing) {
        overallStatus = "healthy";
      } else if (someInfraPassing || allEndpointResults.some((c) => c.status === "pass")) {
        overallStatus = "degraded";
      } else {
        overallStatus = "unhealthy";
      }

      // Store the health check record
      const record: HealthCheckHistoryRecord = {
        timestamp: Timestamp.now(),
        overallStatus,
        infrastructure: {
          firestore: firestoreCheck,
          paystack: paystackCheck,
        },
        endpoints: endpointResults,
      };

      await db.collection("healthCheckHistory").add(record);

      logger.info("SLA health check completed", {
        overallStatus,
        infrastructure: { firestore: firestoreCheck.status, paystack: paystackCheck.status },
        endpointsChecked: Object.keys(endpointResults).length,
      });
    } catch (error) {
      logger.error("SLA health check failed", error);
      throw error;
    }
  }
);
