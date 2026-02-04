// functions/src/slaConfig.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { Timestamp } from "firebase-admin/firestore";

export interface SlaEndpoint {
  name: string;
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  requiresAuth?: boolean;
  testPayload?: Record<string, unknown>;
}

export interface SlaConfigData {
  endpoints: SlaEndpoint[];
  updatedAt?: Timestamp;
}

const CONFIG_DOC_PATH = "_config/slaEndpoints";

/**
 * Get the current SLA endpoint configuration
 * GET /getSlaConfig
 */
export const getSlaConfig = onRequest(
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
      const doc = await db.doc(CONFIG_DOC_PATH).get();

      if (!doc.exists) {
        // Return default config if not set
        const defaultConfig: SlaConfigData = {
          endpoints: [
            { name: "healthCheck", path: "/healthCheck", method: "GET" },
          ],
        };
        res.status(200).json(defaultConfig);
        return;
      }

      const data = doc.data() as SlaConfigData;
      res.status(200).json({
        endpoints: data.endpoints || [],
        updatedAt: data.updatedAt?.toDate().toISOString(),
      });
    } catch (error) {
      logger.error("Error fetching SLA config", error);
      res.status(500).json({ error: "Failed to fetch SLA configuration" });
    }
  }
);

/**
 * Update the SLA endpoint configuration
 * PUT /updateSlaConfig
 * Body: { endpoints: SlaEndpoint[] }
 */
export const updateSlaConfig = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    // Check for admin header
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_HEALTH_KEY && process.env.ENV_TYPE === "production") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (req.method !== "PUT" && req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const { endpoints } = req.body;

      if (!Array.isArray(endpoints)) {
        res.status(400).json({ error: "endpoints must be an array" });
        return;
      }

      // Validate each endpoint
      for (const endpoint of endpoints) {
        if (!endpoint.name || typeof endpoint.name !== "string") {
          res.status(400).json({ error: "Each endpoint must have a name (string)" });
          return;
        }
        if (!endpoint.path || typeof endpoint.path !== "string") {
          res.status(400).json({ error: "Each endpoint must have a path (string)" });
          return;
        }
        if (!endpoint.method || !["GET", "POST", "PUT", "DELETE"].includes(endpoint.method)) {
          res.status(400).json({ error: "Each endpoint must have a valid method (GET, POST, PUT, DELETE)" });
          return;
        }
      }

      const configData: SlaConfigData = {
        endpoints,
        updatedAt: Timestamp.now(),
      };

      await db.doc(CONFIG_DOC_PATH).set(configData, { merge: true });

      logger.info("SLA config updated", { endpointCount: endpoints.length });
      res.status(200).json({
        message: "SLA configuration updated successfully",
        endpoints,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Error updating SLA config", error);
      res.status(500).json({ error: "Failed to update SLA configuration" });
    }
  }
);
