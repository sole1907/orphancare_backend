import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { encrypt } from "./lib/encryption";

export const submitAccountDetails = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    logger.info("Incoming headers:\n" + JSON.stringify(req.headers, null, 2));

    const allowedOrigins = [
      "https://orphancare-93b41.web.app",
      "http://localhost:3000",
    ];
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Origin, Accept"
    );

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

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

      res.json({ success: true });
    } catch (err) {
      logger.error("submitAccountDetails error", err);
      res.status(500).json({ error: "Internal error" });
    }
  }
);
