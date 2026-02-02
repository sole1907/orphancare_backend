import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { auth, db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import { verifyAuth } from "./lib/authUtils";
import { OrphanageData } from "./types/orphanage";
import { loadFeeConfig, computeGrossAmount } from "./lib/feeEngine";

import { handleCors } from "./lib/corsUtils";
import { initPaystackTransaction } from "./lib/paystackUtils";
import {
  computeDonationAmounts,
  logDonationIntent,
  createRecurringPlanIntent,
  abandonExistingPendingDonations,
} from "./lib/donationUtils";
import { allowedOrigins } from "./config/constants";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

export const initiateDonation = onRequest(
  { region: "europe-west1", secrets: [paystackSecret] },
  async (req, res) => {
    logger.info("initiateDonation: incoming headers", req.headers);

    if (handleCors(req, res, allowedOrigins)) return;

    try {
      logger.info("initiateDonation triggered");

      const {
        donorUid,
        donorEmail,
        childId,
        orphanageId,
        baseAmount,
        tipPercent,
        recurring,
        interval,
      } = req.body;

      // 🔐 Auth check
      try {
        const decoded = await verifyAuth(req);
        logger.info(`Donation triggered by uid=${decoded.uid}`);
        if (decoded.uid !== donorUid) {
          logger.error(
            `Forbidden: UID mismatch. decoded=${decoded.uid}, donorUid=${donorUid}`
          );
          res.status(403).send("Forbidden: UID mismatch");
          return;
        }
      } catch (err: any) {
        logger.error("Auth error in initiateDonation", err);
        res.status(err.code || 500).send(err.message || "Internal error");
        return;
      }

      if (!donorUid || !donorEmail || !childId || !orphanageId || !baseAmount) {
        logger.error(
          "Missing required fields in initiateDonation",
          req.body || {}
        );
        res.status(400).send("Missing required fields");
        return;
      }

      const PAYSTACK_URI =
        process.env.PAYSTACK_URI || "https://api.paystack.co";
      const paystackSecretValue = paystackSecret.value();

      const config = await loadFeeConfig();
      logger.info("Loaded fee config", config);

      // ---------------------------------------------------------
      // ONE-OFF DONATION
      // ---------------------------------------------------------
      if (!recurring) {
        logger.info(
          `Processing ONE-OFF donation: donorUid=${donorUid}, childId=${childId}, orphanageId=${orphanageId}, baseAmount=${baseAmount}, tipPercent=${tipPercent}`
        );

        // 1. Fetch orphanage subaccount
        const orphanageDoc = await db
          .collection("orphanages")
          .doc(orphanageId)
          .get();
        if (!orphanageDoc.exists) {
          logger.error(`Invalid orphanage: ${orphanageId}`);
          res.status(400).send("Invalid orphanage");
          return;
        }

        const orphanageData = orphanageDoc.data() as OrphanageData;
        if (!orphanageData.subaccountCode) {
          logger.error(
            `Orphanage has no subaccount configured: ${orphanageId}`
          );
          res.status(400).send("Orphanage has no subaccount configured");
          return;
        }

        const subaccountCode = orphanageData.subaccountCode;

        // 2. Abandon any existing pending donations for same donor/child/orphanage/amount
        await abandonExistingPendingDonations(
          donorUid,
          childId,
          orphanageId,
          false,
          baseAmount
        );

        // 3. Compute amounts
        const tipAmount = Math.round(baseAmount * tipPercent);
        const netAmount = baseAmount + tipAmount;
        const grossAmount = computeGrossAmount(netAmount, config);
        const paystackFee = grossAmount - netAmount;
        const orphanageAmount = Math.round(baseAmount * 100);
        const platformAmount = Math.round(tipAmount * 100);

        logger.info(
          `One-off donation breakdown: base=${baseAmount}, tip=${tipAmount}, net=${netAmount}, fee=${paystackFee}, gross=${grossAmount}`
        );

        // 4. Initialize Paystack transaction
        const initData = await initPaystackTransaction({
          email: donorEmail,
          amount: grossAmount * 100,
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
            recurring: false,
          },
          callbackUrl: "https://orphancare-93b41.web.app/payment-result",
          paystackSecretValue,
          PAYSTACK_URI,
          subaccount: subaccountCode,
          transactionCharge: platformAmount,
        });

        // 5. Log donation intent
        await logDonationIntent({
          donorUid,
          donorEmail,
          childId,
          orphanageId,
          grossAmount,
          baseAmount,
          tipPercent,
          tipAmount,
          netAmount,
          paystackFee,
          orphanageAmount,
          platformAmount,
          recurring: false,
          interval: null,
          paystackRef: initData.reference,
        });

        logger.info(
          `One-off donation initialized successfully. Redirecting donor to Paystack. ref=${initData.reference}`
        );

        res.json({ checkoutUrl: initData.authorization_url });
        return;
      }

      // ---------------------------------------------------------
      // RECURRING DONATION (CHARGE AUTHORIZATION MODEL)
      // ---------------------------------------------------------
      logger.info(
        `Processing RECURRING donation: donorUid=${donorUid}, childId=${childId}, orphanageId=${orphanageId}, baseAmount=${baseAmount}, tipPercent=${tipPercent}, interval=${interval}`
      );

      // Validate interval (daily only allowed in non-production)
      const isProd = process.env.ENV_TYPE === "production";
      const allowedIntervals = ["monthly", "quarterly", "yearly"];
      if (!isProd) {
        allowedIntervals.push("daily");
      }

      if (!interval || !allowedIntervals.includes(interval.toLowerCase())) {
        logger.error(
          `Invalid interval: ${interval}. Allowed: ${allowedIntervals.join(", ")}`
        );
        res
          .status(400)
          .send(`Invalid interval. Allowed: ${allowedIntervals.join(", ")}`);
        return;
      }

      // 1. Fetch orphanage subaccount (same as one-off)
      const orphanageDocRecurring = await db
        .collection("orphanages")
        .doc(orphanageId)
        .get();
      if (!orphanageDocRecurring.exists) {
        logger.error(`Invalid orphanage: ${orphanageId}`);
        res.status(400).send("Invalid orphanage");
        return;
      }

      const orphanageDataRecurring = orphanageDocRecurring.data() as OrphanageData;
      if (!orphanageDataRecurring.subaccountCode) {
        logger.error(
          `Orphanage has no subaccount configured: ${orphanageId}`
        );
        res.status(400).send("Orphanage has no subaccount configured");
        return;
      }

      const subaccountCodeRecurring = orphanageDataRecurring.subaccountCode;

      // 2. Abandon any existing pending donations for same donor/child/orphanage/amount
      await abandonExistingPendingDonations(
        donorUid,
        childId,
        orphanageId,
        true,
        baseAmount
      );

      // 3. Compute amounts
      const tipAmount = Math.round(baseAmount * tipPercent);
      const netAmount = baseAmount + tipAmount;
      const grossAmount = computeGrossAmount(netAmount, config);
      const paystackFeeEstimate = grossAmount - netAmount;
      const orphanageAmount = Math.round(baseAmount * 100);
      const platformAmount = Math.round(tipAmount * 100);

      logger.info(
        `Recurring donation breakdown: base=${baseAmount}, tip=${tipAmount}, net=${netAmount}, gross=${grossAmount}, feeEstimate=${paystackFeeEstimate}`
      );

      // 4. Create recurring plan FIRST (so we have planCode for metadata)
      const planCode = await createRecurringPlanIntent({
        donorUid,
        childId,
        orphanageId,
        baseAmount,
        tipPercent,
        tipAmount,
        netAmount,
        grossAmount,
        paystackFeeEstimate,
        orphanageAmount,
        platformAmount,
        interval,
        donorEmail,
      });

      logger.info(`Recurring plan created: planCode=${planCode}`);

      // 5. Initialize FIRST PAYMENT with split (capture authorization_code via webhook)
      const initData = await initPaystackTransaction({
        email: donorEmail,
        amount: grossAmount * 100,
        metadata: {
          donorUid,
          childId,
          orphanageId,
          tipPercent,
          planCode,
          recurring: true,
        },
        callbackUrl: "https://orphancare-93b41.web.app/payment-result",
        paystackSecretValue,
        PAYSTACK_URI,
        subaccount: subaccountCodeRecurring,
        transactionCharge: platformAmount,
      });

      logger.info(
        `Redirecting donor to Paystack. planCode=${planCode}, ref=${initData.reference}`
      );

      // 6. Log donation intent (so checkDonationStatus can find it by paystackRef)
      await logDonationIntent({
        donorUid,
        donorEmail,
        childId,
        orphanageId,
        grossAmount,
        baseAmount,
        tipPercent,
        tipAmount,
        netAmount,
        paystackFee: paystackFeeEstimate,
        orphanageAmount,
        platformAmount,
        recurring: true,
        interval,
        paystackRef: initData.reference,
      });

      // 7. Return checkout URL + planCode
      res.json({
        checkoutUrl: initData.authorization_url,
        planCode,
      });
    } catch (error) {
      logger.error("Donation error in initiateDonation", error);
      res.status(500).send("Internal error");
    }
  }
);
