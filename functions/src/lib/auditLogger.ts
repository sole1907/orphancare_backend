// functions/src/lib/auditLogger.ts
import { db } from "./firebaseAdmin";
import * as logger from "firebase-functions/logger";
import { FieldValue } from "firebase-admin/firestore";

// Audit action categories
export enum AuditCategory {
  TIER_1_CRITICAL = "TIER_1_CRITICAL",
  TIER_2_HIGH = "TIER_2_HIGH",
  TIER_3_MEDIUM = "TIER_3_MEDIUM",
  TIER_4_LOW = "TIER_4_LOW",
}

// Audit actions
export enum AuditAction {
  // Tier 1 - Critical (Financial/Approval)
  APPROVE_BANK_ACCOUNT = "approve_bank_account",
  REJECT_BANK_ACCOUNT = "reject_bank_account",
  CREATE_ORPHANAGE = "create_orphanage",

  // Tier 2 - High (Data Management)
  UPDATE_ORPHANAGE = "update_orphanage",
  SUBMIT_BANK_ACCOUNT = "submit_bank_account",
  VERIFY_BANK_ACCOUNT = "verify_bank_account",
  CREATE_CHILD = "create_child",
  UPDATE_CHILD = "update_child",
  DELETE_CHILD = "delete_child",

  // Tier 3 - Medium (Content)
  CREATE_UPDATE = "create_update",
  EDIT_UPDATE = "edit_update",
  DELETE_UPDATE = "delete_update",
  CREATE_HOBBY = "create_hobby",
  UPDATE_HOBBY = "update_hobby",
  DELETE_HOBBY = "delete_hobby",
  CREATE_FAQ = "create_faq",
  UPDATE_FAQ = "update_faq",
  DELETE_FAQ = "delete_faq",
  REFRESH_BANK_LIST = "refresh_bank_list",

  // Tier 4 - Low (Monitoring)
  LOGIN = "login",
  LOGOUT = "logout",
  FAILED_LOGIN = "failed_login",
  FAILED_ACTION = "failed_action",
}

// Resource types
export enum ResourceType {
  ORPHANAGE = "orphanage",
  CHILD = "child",
  DONOR = "donor",
  DONATION = "donation",
  UPDATE = "update",
  HOBBY = "hobby",
  FAQ = "faq",
  BANK = "bank",
  USER = "user",
}

// User roles
export type UserRole = "superAdmin" | "orphanageAdmin" | "donor";

// Audit log entry interface
export interface AuditLogEntry {
  timestamp: FirebaseFirestore.FieldValue;
  action: AuditAction;
  category: AuditCategory;
  actorId: string;
  actorEmail: string;
  actorRole: UserRole;
  orphanageId: string | null;
  resourceType: ResourceType;
  resourceId: string;
  details: Record<string, any>;
  ipAddress: string;
  userAgent: string;
  success: boolean;
  errorMessage: string | null;
}

// Map actions to categories
const ACTION_CATEGORY_MAP: Record<AuditAction, AuditCategory> = {
  // Tier 1
  [AuditAction.APPROVE_BANK_ACCOUNT]: AuditCategory.TIER_1_CRITICAL,
  [AuditAction.REJECT_BANK_ACCOUNT]: AuditCategory.TIER_1_CRITICAL,
  [AuditAction.CREATE_ORPHANAGE]: AuditCategory.TIER_1_CRITICAL,

  // Tier 2
  [AuditAction.UPDATE_ORPHANAGE]: AuditCategory.TIER_2_HIGH,
  [AuditAction.SUBMIT_BANK_ACCOUNT]: AuditCategory.TIER_2_HIGH,
  [AuditAction.VERIFY_BANK_ACCOUNT]: AuditCategory.TIER_2_HIGH,
  [AuditAction.CREATE_CHILD]: AuditCategory.TIER_2_HIGH,
  [AuditAction.UPDATE_CHILD]: AuditCategory.TIER_2_HIGH,
  [AuditAction.DELETE_CHILD]: AuditCategory.TIER_2_HIGH,

  // Tier 3
  [AuditAction.CREATE_UPDATE]: AuditCategory.TIER_3_MEDIUM,
  [AuditAction.EDIT_UPDATE]: AuditCategory.TIER_3_MEDIUM,
  [AuditAction.DELETE_UPDATE]: AuditCategory.TIER_3_MEDIUM,
  [AuditAction.CREATE_HOBBY]: AuditCategory.TIER_3_MEDIUM,
  [AuditAction.UPDATE_HOBBY]: AuditCategory.TIER_3_MEDIUM,
  [AuditAction.DELETE_HOBBY]: AuditCategory.TIER_3_MEDIUM,
  [AuditAction.CREATE_FAQ]: AuditCategory.TIER_3_MEDIUM,
  [AuditAction.UPDATE_FAQ]: AuditCategory.TIER_3_MEDIUM,
  [AuditAction.DELETE_FAQ]: AuditCategory.TIER_3_MEDIUM,
  [AuditAction.REFRESH_BANK_LIST]: AuditCategory.TIER_3_MEDIUM,

  // Tier 4
  [AuditAction.LOGIN]: AuditCategory.TIER_4_LOW,
  [AuditAction.LOGOUT]: AuditCategory.TIER_4_LOW,
  [AuditAction.FAILED_LOGIN]: AuditCategory.TIER_4_LOW,
  [AuditAction.FAILED_ACTION]: AuditCategory.TIER_4_LOW,
};

// PII fields to redact from audit logs
const PII_FIELDS = [
  "email",
  "phone",
  "password",
  "authorizationCode",
  "accountNumber",
  "otp",
  "token",
  "secret",
];

/**
 * Sanitize details object by redacting PII fields
 */
function sanitizeDetails(details: Record<string, any>): Record<string, any> {
  const sanitized = { ...details };

  for (const field of PII_FIELDS) {
    if (field in sanitized) {
      sanitized[field] = "[REDACTED]";
    }
    // Also check nested objects
    for (const key of Object.keys(sanitized)) {
      if (
        typeof sanitized[key] === "object" &&
        sanitized[key] !== null &&
        field in sanitized[key]
      ) {
        sanitized[key] = { ...sanitized[key], [field]: "[REDACTED]" };
      }
    }
  }

  return sanitized;
}

/**
 * Extract role from decoded auth token
 */
function extractRole(decoded: any): UserRole {
  if (decoded.superAdmin) return "superAdmin";
  if (decoded.orphanageAdmin) return "orphanageAdmin";
  if (decoded.donor) return "donor";
  return "donor"; // Default
}

/**
 * Extract IP address from request
 */
function extractIP(req: any): string {
  const forwardedFor = req.headers?.["x-forwarded-for"];
  if (typeof forwardedFor === "string") {
    return forwardedFor.split(",")[0].trim();
  }
  if (Array.isArray(forwardedFor)) {
    return forwardedFor[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || "unknown";
}

/**
 * AuditLogger class for logging admin actions
 */
export class AuditLogger {
  private static instance: AuditLogger;

  private constructor() {}

  static getInstance(): AuditLogger {
    if (!AuditLogger.instance) {
      AuditLogger.instance = new AuditLogger();
    }
    return AuditLogger.instance;
  }

  /**
   * Log an audit entry
   * Fire-and-forget to avoid blocking main request
   */
  async log(entry: Omit<AuditLogEntry, "timestamp">): Promise<void> {
    try {
      await db.collection("audit_logs").add({
        ...entry,
        timestamp: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      // Log to Cloud Logging as backup - audit logging should never break main flow
      logger.error("Audit log write failed", { entry, error: err });
    }
  }

  /**
   * Log an audit entry with request context
   */
  async logWithRequest(params: {
    request: any;
    auth: any;
    action: AuditAction;
    resourceType: ResourceType;
    resourceId: string;
    details: Record<string, any>;
    success: boolean;
    errorMessage?: string;
  }): Promise<void> {
    const { request, auth, action, resourceType, resourceId, details, success, errorMessage } =
      params;

    await this.log({
      action,
      category: ACTION_CATEGORY_MAP[action],
      actorId: auth.uid || "unknown",
      actorEmail: auth.email || "unknown",
      actorRole: extractRole(auth),
      orphanageId: auth.orphanageId || null,
      resourceType,
      resourceId,
      details: sanitizeDetails(details),
      ipAddress: extractIP(request),
      userAgent: request.headers?.["user-agent"] || "unknown",
      success,
      errorMessage: errorMessage || null,
    });
  }
}

/**
 * Higher-order function to wrap Cloud Functions with audit logging
 * Use this to automatically log actions before and after function execution
 */
export function withAuditLogging<T>(
  action: AuditAction,
  resourceType: ResourceType,
  getResourceId: (req: any) => string,
  handler: (req: any, context: any) => Promise<T>
): (req: any, context: any) => Promise<T> {
  return async (req, context) => {
    const auditLogger = AuditLogger.getInstance();
    const resourceId = getResourceId(req);
    const auth = context.auth || {};
    const details = req.body || req.data || {};

    try {
      const result = await handler(req, context);

      // Log success
      await auditLogger.logWithRequest({
        request: req,
        auth,
        action,
        resourceType,
        resourceId,
        details,
        success: true,
      });

      return result;
    } catch (error: any) {
      // Log failure
      await auditLogger.logWithRequest({
        request: req,
        auth,
        action,
        resourceType,
        resourceId,
        details,
        success: false,
        errorMessage: error.message || String(error),
      });

      throw error;
    }
  };
}

// Export singleton instance for convenience
export const auditLogger = AuditLogger.getInstance();
