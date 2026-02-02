// functions/src/getAuditLogs.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { AuditAction, AuditCategory } from "./lib/auditLogger";

interface AuditLogResponse {
  logs: any[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
}

export const getAuditLogs = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      // Auth check - must be superAdmin or orphanageAdmin
      let isSuperAdmin = false;
      let orphanageId: string | null = null;
      let decoded: any;

      try {
        decoded = await verifyAuth(req, {
          requiredRoles: ["superAdmin", "orphanageAdmin"],
        });

        isSuperAdmin = !!decoded.superAdmin;
        orphanageId = decoded.orphanageId as string | null;

        logger.info(
          `getAuditLogs triggered by ${decoded.uid}, superAdmin=${isSuperAdmin}, orphanageId=${orphanageId}`
        );
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      // Parse query parameters
      const {
        page = 1,
        pageSize = 20,
        action,
        category,
        startDate,
        endDate,
        filterOrphanageId,
        resourceType,
        success,
      } = req.body;

      // Limit page size to prevent abuse
      const limitedPageSize = Math.min(pageSize, 100);

      // Build query
      let query: FirebaseFirestore.Query = db.collection("audit_logs");

      // Role-based filtering - orphanageAdmin can only see their own orphanage's logs
      if (!isSuperAdmin) {
        if (!orphanageId) {
          res.status(403).json({ error: "No orphanage associated with user" });
          return;
        }
        query = query.where("orphanageId", "==", orphanageId);
      } else if (filterOrphanageId) {
        // SuperAdmin can optionally filter by orphanageId
        query = query.where("orphanageId", "==", filterOrphanageId);
      }

      // Apply filters
      if (action) {
        query = query.where("action", "==", action);
      }

      if (category) {
        query = query.where("category", "==", category);
      }

      if (resourceType) {
        query = query.where("resourceType", "==", resourceType);
      }

      if (typeof success === "boolean") {
        query = query.where("success", "==", success);
      }

      // Date range filters
      if (startDate) {
        query = query.where("timestamp", ">=", new Date(startDate));
      }

      if (endDate) {
        query = query.where("timestamp", "<=", new Date(endDate));
      }

      // Order by timestamp descending (most recent first)
      query = query.orderBy("timestamp", "desc");

      // Get total count (for pagination info)
      // Note: This is inefficient for large datasets; consider caching or removing
      const countSnapshot = await query.count().get();
      const total = countSnapshot.data().count;

      // Apply pagination
      const offset = (page - 1) * limitedPageSize;
      query = query.offset(offset).limit(limitedPageSize);

      // Execute query
      const snapshot = await query.get();

      const logs = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          timestamp: data.timestamp?.toDate?.()?.toISOString?.() || null,
        };
      });

      const totalPages = Math.ceil(total / limitedPageSize);
      const hasMore = page < totalPages;

      const response: AuditLogResponse = {
        logs,
        total,
        page,
        pageSize: limitedPageSize,
        totalPages,
        hasMore,
      };

      logger.info(`Returning ${logs.length} of ${total} audit logs`);
      res.json({ data: response });
    } catch (error) {
      logger.error("getAuditLogs error", error);
      res.status(500).send("Internal error");
    }
  }
);

// Export available actions and categories for the UI
export const getAuditLogFilters = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      await verifyAuth(req, {
        requiredRoles: ["superAdmin", "orphanageAdmin"],
      });

      res.json({
        data: {
          actions: Object.values(AuditAction),
          categories: Object.values(AuditCategory),
        },
      });
    } catch (err: any) {
      logger.error("Auth error", err);
      res.status(err.code || 401).send(err.message || "Unauthorized");
    }
  }
);
