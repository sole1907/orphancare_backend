import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import fetch from "node-fetch";
import { verifyAuth } from "./lib/authUtils";
import { decrypt } from "./lib/encryption";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

export const approveOrphanageAccount = onRequest(
  { region: "europe-west1", secrets: [paystackSecret] },
  async (req, res) => {
    logger.info("Incoming headers:\n" + JSON.stringify(req.headers, null, 2));

    if (handleCors(req, res, allowedOrigins)) return;

    try {
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

      let subaccountCode = data.subaccountCode;

      // --- CREATE OR UPDATE SUBACCOUNT ---
      if (!subaccountCode) {
        // Create new subaccount
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
            percentage_charge: 0,
          }),
        });

        const json = await response.json();
        if (!json.status) {
          logger.error("Paystack subaccount creation failed", json);
          res.status(400).json({ error: json.message });
          return;
        }

        subaccountCode = json.data.subaccount_code;
      } else {
        // Update existing subaccount
        const response = await fetch(
          `${PAYSTACK_URI}/subaccount/${subaccountCode}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${paystackSecret.value()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              settlement_bank: data.bankCode,
              account_number: fullAccountNumber,
            }),
          }
        );

        const json = await response.json();
        if (!json.status) {
          logger.error("Paystack subaccount update failed", json);
          res.status(400).json({ error: json.message });
          return;
        }
      }

      // --- UPDATE FIRESTORE ---
      await ref.update({
        subaccountCode,
        accountVerificationStatus: "approved",
        accountNumberEncrypted: null, // remove sensitive data
        updatedAt: new Date(),
      });

      res.json({ success: true, subaccountCode });
    } catch (err) {
      logger.error("Approval error", err);
      res.status(500).json({ error: "Internal error" });
    }
  }
);
