import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import fetch from "node-fetch";
import { verifyAuth } from "./lib/authUtils";
import { decrypt } from "./lib/encryption";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

export const approveOrphanageAccount = onRequest(
  { region: "europe-west1", secrets: [paystackSecret] },
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
      // Auth check
      const decoded = await verifyAuth(req, {
        requiredRoles: ["superAdmin"],
      });
      logger.info(`Approval triggered by ${decoded.uid}`);

      const { orphanageId } = req.body;
      if (!orphanageId) {
        res.status(400).json({ error: "Missing orphanageId" });
        return;
      }

      const ref = db.collection("orphanages").doc(orphanageId);
      const snap = await ref.get();

      if (!snap.exists) {
        res.status(404).json({ error: "Orphanage not found" });
        return;
      }

      const data = snap.data() as any;

      // Decrypt the stored account number
      const encrypted = data.accountNumberEncrypted;
      if (!encrypted) {
        res.status(400).json({
          error:
            "Encrypted account number missing. Ensure it was stored during submission.",
        });
        return;
      }

      const fullAccountNumber = await decrypt(encrypted);

      const PAYSTACK_URI =
        process.env.PAYSTACK_URI || "https://api.paystack.co";

      // Create Paystack subaccount
      const response = await fetch(`${PAYSTACK_URI}/subaccount`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paystackSecret.value()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          business_name: data.name,
          settlement_bank: data.bankCode,
          account_number: fullAccountNumber,
          percentage_charge: 0, // 0% platform fee
        }),
      });

      const json = await response.json();

      if (!json.status) {
        logger.error("Paystack subaccount creation failed", json);
        res.status(400).json({ error: json.message });
        return;
      }

      const subaccountCode = json.data.subaccount_code;

      // Update Firestore
      await ref.update({
        subaccountCode,
        accountVerificationStatus: "approved",
        accountNumberEncrypted: null, // optional: remove sensitive data
      });

      res.json({ success: true, subaccountCode });
    } catch (err) {
      logger.error("Approval error", err);
      res.status(500).json({ error: "Internal error" });
    }
  }
);
