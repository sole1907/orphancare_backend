import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { encrypt } from "./lib/encryption";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { auditLogger, AuditAction, ResourceType } from "./lib/auditLogger";

export const submitAccountDetails = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    logger.info("Incoming headers:\n" + JSON.stringify(req.headers, null, 2));

    if (handleCors(req, res, allowedOrigins)) return;

    try {
      const decoded = await verifyAuth(req, {
        requiredRoles: ["orphanageAdmin"],
      });

      const { bankName, bankCode, accountName, accountNumber } = req.body;

      if (!bankName || !bankCode || !accountName || !accountNumber) {
        res.status(400).json({ error: "Missing required fields" });
        return;
      }

      if (accountNumber.length !== 10) {
        res.status(400).json({ error: "Invalid account number" });
        return;
      }

      const encrypted = await encrypt(accountNumber);
      const masked = accountNumber.replace(/\d(?=\d{4})/g, "*");
      const last4 = accountNumber.slice(-4);

      const orphanageId = decoded.orphanageId;
      const ref = db.collection("orphanages").doc(orphanageId);

      await ref.update({
        bankName,
        bankCode,
        accountName,
        accountNumberEncrypted: encrypted,
        accountNumberMasked: masked,
        accountNumberLast4: last4,
        accountVerificationStatus: "otp_pending", // restart verification
        updatedAt: new Date(),
      });

      // Audit log - successful submission
      await auditLogger.logWithRequest({
        request: req,
        auth: decoded,
        action: AuditAction.SUBMIT_BANK_ACCOUNT,
        resourceType: ResourceType.ORPHANAGE,
        resourceId: orphanageId,
        details: {
          bankName,
          bankCode,
          accountName,
          accountNumberLast4: last4,
        },
        success: true,
      });

      res.json({ success: true });
    } catch (err: any) {
      logger.error("submitAccountDetails error", err);
      res.status(500).json({ error: "Internal error" });
    }
  }
);
