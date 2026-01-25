import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import fetch from "node-fetch";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

export const checkDonationStatus = onRequest(
  { region: "europe-west1", secrets: [paystackSecret] },
  async (req, res) => {
    logger.info("Incoming headers:\n" + JSON.stringify(req.headers, null, 2));

    if (handleCors(req, res, allowedOrigins)) return;

    try {
      logger.info("checkDonationStatus triggered");
      // 🔐 Auth check
      try {
        const decoded = await verifyAuth(req);
        logger.info(`Invite triggered by ${decoded.uid}`); // ... rest of your logic
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 500).send(err.message || "Internal error");
        return;
      }

      const { reference } = req.body;

      if (!reference) {
        res.status(400).send("Missing reference");
        logger.error("Missing reference");
        return;
      }

      const snapshot = await db
        .collection("donations")
        .where("paystackRef", "==", reference)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        const status = doc.data()?.status;
        if (status === "success" || status === "failed") {
          res.json({ status });
          return;
        }
      }

      const PAYSTACK_URI =
        process.env.PAYSTACK_URI || "https://api.paystack.co";

      // If not final, check Paystack
      const response = await fetch(
        `${PAYSTACK_URI}/transaction/verify/${reference}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${paystackSecret.value()}`,
            "Content-Type": "application/json",
          },
        }
      );

      const result = await response.json();
      const paystackStatus = result.data?.status; // "success" | "failed" | "pending"

      if (paystackStatus === "success" || paystackStatus === "failed") {
        if (!snapshot.empty) {
          await snapshot.docs[0].ref.update({
            status: paystackStatus,
            updatedAt: new Date(),
          });
          res.json({ status: paystackStatus });
        } else {
          logger.error(`No donation found for reference: ${reference}`);
          res.status(404).send("Donation not found");
        }
      } else {
        res.json({ status: "pending" });
      }
    } catch (error) {
      logger.error("Status check error", error);
      res.status(500).send("Internal error");
    }
  }
);
