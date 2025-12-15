import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore } from "./firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import fetch from "node-fetch";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");
const db = getFirestore();

export const checkDonationStatus = onRequest(
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
      logger.info("Preflight request received FROM ", origin);
      res.status(204).send("");
      return;
    }

    try {
      logger.info("checkDonationStatus triggered");
      const { reference } = req.body;

      if (!reference) {
        res.status(400).send("Missing reference");
        logger.error("Missing reference");
        return;
      }

      const docRef = db.collection("donations").doc(reference);
      const doc = await docRef.get();

      if (doc.exists) {
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
        await docRef.set({ status: paystackStatus }, { merge: true });
        res.json({ status: paystackStatus });
      } else {
        res.json({ status: "pending" });
      }
    } catch (error) {
      logger.error("Status check error", error);
      res.status(500).send("Internal error");
    }
  }
);
