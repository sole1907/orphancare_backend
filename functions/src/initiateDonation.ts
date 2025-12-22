// functions/src/initiateDonation.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { auth, db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import fetch from "node-fetch";
import { verifyAuth } from "./lib/authUtils";
import { OrphanageData } from "./types/orphanage";
import { loadFeeConfig, computeGrossAmount } from "./lib/feeEngine";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

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
        amount, // still the total entered by user (base + tip) on client
        baseAmount,
        tipPercent,
        recurring,
        interval,
      } = req.body;

      // 🔐 Auth check
      try {
        const decoded = await verifyAuth(req);
        logger.info(`Donation triggered by ${decoded.uid}`);
        if (decoded.uid !== donorUid) {
          res.status(403).send("Forbidden: UID mismatch");
          return;
        }
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 500).send(err.message || "Internal error");
        return;
      }

      if (
        !donorUid ||
        !donorEmail ||
        !childId ||
        !orphanageId ||
        !amount ||
        !baseAmount
      ) {
        res.status(400).send("Missing required fields");
        logger.error("Missing required fields");
        return;
      }

      const PAYSTACK_URI =
        process.env.PAYSTACK_URI || "https://api.paystack.co";

      const config = await loadFeeConfig();

      // One-off donation
      if (!recurring) {
        // 1. Fetch orphanage subaccount
        const orphanageDoc = await db
          .collection("orphanages")
          .doc(orphanageId)
          .get();
        if (!orphanageDoc.exists) {
          res.status(400).send("Invalid orphanage");
          return;
        }

        const orphanageData = orphanageDoc.data() as OrphanageData;
        if (!orphanageData.subaccountCode) {
          res.status(400).send("Orphanage has no subaccount configured");
          return;
        }

        const subaccountCode = orphanageData.subaccountCode;

        // 2. Compute amounts (server-side, ignore client’s fee assumptions)
        const tipAmount = Math.round(baseAmount * tipPercent);
        const netAmount = baseAmount + tipAmount;

        const grossAmount = computeGrossAmount(netAmount, config);
        const paystackFee = grossAmount - netAmount;

        const orphanageAmount = Math.round(baseAmount * 100); // in kobo
        const platformAmount = Math.round(tipAmount * 100); // in kobo

        logger.info(
          `Donation breakdown: base=${baseAmount}, tip=${tipAmount}, net=${netAmount}, fee=${paystackFee}, gross=${grossAmount}`
        );

        // 3. Initialize Paystack transaction
        const response = await fetch(`${PAYSTACK_URI}/transaction/initialize`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecret.value()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: donorEmail,
            amount: grossAmount * 100, // donor pays fee
            subaccount: subaccountCode,
            bearer: "account", // donor covers fee
            transaction_charge: platformAmount, // platform receives tip
            metadata: {
              donorUid,
              childId,
              orphanageId,
              tipPercent,
              baseAmount,
              tipAmount,
              netAmount,
              paystackFee,
              grossAmount,
            },
            callback_url: "https://orphancare-93b41.web.app/payment-result",
          }),
        });

        const data = await response.json();
        if (!data.status) {
          throw new Error(data.message || "Paystack init failed");
        }

        // 4. Log donation intent
        await db.collection("donations").add({
          donorUid,
          childId,
          orphanageId,
          amount: grossAmount, // what donor will actually be charged
          baseAmount,
          tipPercent,
          tipAmount,
          netAmount,
          paystackFee,
          orphanageAmount,
          platformAmount,
          recurring: false,
          interval: null,
          paystackRef: data.data.reference,
          createdAt: new Date(),
          status: "pending",
        });

        res.json({ checkoutUrl: data.data.authorization_url });
      } else {
        // Recurring donation: create plan (you can later adapt to use fee engine per cycle)
        const planResponse = await fetch("https://api.paystack.co/plan", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecret.value()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `Donation Plan ${interval}`,
            interval: interval.toLowerCase(), // monthly, quarterly, yearly
            amount: Math.round(amount * 100), // currently charging net; can adjust later
          }),
        });

        const planData = await planResponse.json();
        if (!planData.status) {
          throw new Error(planData.message || "Paystack plan failed");
        }

        const tipAmount = Math.round(baseAmount * tipPercent);
        const netAmount = baseAmount + tipAmount;

        const orphanageAmount = Math.round(baseAmount * 100);
        const platformAmount = Math.round(tipAmount * 100);

        // Log donation intent for recurring
        await db.collection("donations").add({
          donorUid,
          childId,
          orphanageId,
          amount: netAmount, // per charge net (base + tip)
          baseAmount,
          tipPercent,
          tipAmount,
          orphanageAmount,
          platformAmount,
          recurring: true,
          interval,
          paystackRef: planData.data.id, // plan ID
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
