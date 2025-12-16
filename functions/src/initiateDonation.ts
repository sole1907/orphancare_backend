import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore } from "./firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import fetch from "node-fetch";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");
const db = getFirestore();

export const initiateDonation = onRequest(
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
      logger.info("initiateDonation triggered");
      const {
        donorUid,
        donorEmail,
        childId,
        orphanageId,
        amount,
        baseAmount,
        tipPercent,
        recurring,
        interval,
      } = req.body;

      if (!donorUid || !donorEmail || !childId || !orphanageId || !amount) {
        res.status(400).send("Missing required fields");
        logger.error("Missing required fields");
        return;
      }

      const PAYSTACK_URI =
        process.env.PAYSTACK_URI || "https://api.paystack.co";

      // One-off donation
      if (!recurring) {
        const response = await fetch(`${PAYSTACK_URI}/transaction/initialize`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecret.value()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: donorEmail,
            amount: Math.round(amount * 100), // Paystack expects kobo
            metadata: { donorUid, childId, orphanageId, tipPercent },
            callback_url: "https://orphancare-93b41.web.app/payment-result", // dummy hosted callback to be intercepted on mobile app
          }),
        });

        const data = await response.json();
        if (!data.status) {
          throw new Error(data.message || "Paystack init failed");
        }

        // Optionally log donation intent
        await db.collection("donations").add({
          donorUid,
          childId,
          orphanageId,
          amount,
          baseAmount,
          tipPercent,
          recurring: false,
          interval: null,
          paystackRef: data.data.reference,
          createdAt: new Date(),
          status: "pending",
        });

        res.json({ checkoutUrl: data.data.authorization_url });
      } else {
        // Recurring donation: create plan
        const planResponse = await fetch("https://api.paystack.co/plan", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecret.value()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `Donation Plan ${interval}`,
            interval: interval.toLowerCase(), // monthly, quarterly, yearly
            amount: Math.round(amount * 100),
          }),
        });

        const planData = await planResponse.json();
        if (!planData.status) {
          throw new Error(planData.message || "Paystack plan failed");
        }

        // Log donation intent
        await db.collection("donations").add({
          donorUid,
          childId,
          orphanageId,
          amount,
          baseAmount,
          tipPercent,
          recurring: true,
          interval,
          paystackRef: planData.data.id,
          createdAt: new Date(),
          status: "pending",
        });

        res.json({ planId: String(planData.data.id) });
      }
    } catch (error) {
      logger.error("Donation error", error);
      res.status(500).send("Internal error");
    }
  }
);
