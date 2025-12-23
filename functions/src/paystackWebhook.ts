import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import * as crypto from "crypto";
import fetch from "node-fetch";
import { OrphanageData } from "./types/orphanage";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

export const paystackWebhook = onRequest(
  { region: "europe-west1", secrets: [paystackSecret] },
  async (req: any, res: any) => {
    try {
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim();
      const allowedIps = ["52.31.139.75", "52.49.173.169", "52.214.14.220"];

      if (!ip || !allowedIps.includes(ip)) {
        logger.error(`Unauthorized IP: ${ip}`);
        res.status(403).send("Forbidden: Invalid source IP");
        return;
      }

      const PAYSTACK_URI =
        process.env.PAYSTACK_URI || "https://api.paystack.co";
      const event = req.body;

      // Verify signature
      const signature = req.headers["x-paystack-signature"] as string;
      const expected = crypto
        .createHmac("sha512", paystackSecret.value())
        .update(JSON.stringify(req.body))
        .digest("hex");

      if (signature !== expected) {
        logger.error("Invalid signature");
        res.status(400).send("Invalid signature");
        return;
      }

      logger.info(`Webhook event: ${event.event}`);

      // ---------------------------------------------------------
      // ONE-OFF SUCCESS
      // ---------------------------------------------------------
      if (event.event === "charge.success") {
        const ref = event.data.reference;
        const snapshot = await db
          .collection("donations")
          .where("paystackRef", "==", ref)
          .get();

        snapshot.forEach((doc) => {
          doc.ref.update({ status: "success", updatedAt: new Date() });
        });
      }

      // ---------------------------------------------------------
      // RECURRING SUCCESS — SMART SPLIT + DONATION ENTRY
      // ---------------------------------------------------------
      if (event.event === "invoice.payment_succeeded") {
        const planCode = event.data.plan.plan_code; // MUST use plan_code
        const chargeId = event.data.id;
        const donorEmail = event.data.customer.email;
        const grossAmount = event.data.amount / 100; // donor paid
        const invoiceNumber = event.data.invoice_number;

        // 1. Find the recurring plan definition
        const planDoc = await db
          .collection("recurringPlans")
          .doc(planCode)
          .get();
        if (!planDoc.exists) {
          logger.error("No matching recurring plan found:", planCode);
          res.status(200).send("No matching plan");
          return;
        }

        const plan = planDoc.data();

        if (!plan) {
          logger.error("Recurring plan document is empty:", planCode);
          res.status(200).send("Invalid plan document");
          return;
        }

        const orphanageId = plan.orphanageId;
        const expectedNet = plan.netAmount;
        const orphanageAmount = plan.orphanageAmount; // kobo
        const platformAmount = plan.platformAmount; // kobo

        // 2. Fetch orphanage subaccount
        const orphanageDoc = await db
          .collection("orphanages")
          .doc(orphanageId)
          .get();
        if (!orphanageDoc.exists) {
          logger.error("Orphanage not found:", orphanageId);
          res.status(200).send("Orphanage missing");
          return;
        }

        const orphanageData = orphanageDoc.data();
        const subaccountCode = orphanageData?.subaccountCode;

        if (!subaccountCode) {
          logger.error("Orphanage missing subaccountCode:", orphanageId);
          res.status(200).send("Missing subaccount");
          return;
        }

        // 3. Compute actual fee
        const netReceived = grossAmount; // Paystack already deducted fee
        const actualFee = grossAmount - netReceived;
        const difference = expectedNet - netReceived;

        logger.info(
          `Recurring charge: gross=${grossAmount}, netReceived=${netReceived}, expectedNet=${expectedNet}, fee=${actualFee}, diff=${difference}`
        );

        // 4. Adjust payouts
        let orphanagePayout = orphanageAmount;
        let platformPayout = platformAmount;

        const diffKobo = Math.round(difference * 100);

        if (diffKobo > 0) {
          if (platformPayout >= diffKobo) {
            // Tip absorbs fee difference
            platformPayout -= diffKobo;
          } else {
            // Tip not enough → orphanage absorbs remainder
            const remaining = diffKobo - platformPayout;
            platformPayout = 0;

            if (orphanagePayout >= remaining) {
              orphanagePayout -= remaining;
            } else {
              orphanagePayout = 0;
            }
          }
        }

        // 5. Apply split
        await fetch(`${PAYSTACK_URI}/transaction/split`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecret.value()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            transaction: chargeId,
            subaccount: subaccountCode,
            share: orphanagePayout,
          }),
        });

        // 6. Create donation entry (this is REAL money movement)
        await db.collection("donations").add({
          donorUid: plan.donorUid,
          donorEmail,
          childId: plan.childId,
          orphanageId,
          planCode,
          grossAmount,
          netReceived,
          actualFee,
          expectedNet,
          differenceAbsorbed: difference,
          orphanagePayout,
          platformPayout,
          status: "success",
          recurring: true,
          interval: plan.interval,
          createdAt: new Date(),
          paystackRef: invoiceNumber,
          cycle: invoiceNumber,
        });

        // 7. Mark plan as active (first payment succeeded)
        if (plan.status !== "active") {
          await planDoc.ref.update({
            status: "active",
            activatedAt: new Date(),
          });
        }
      }

      // ---------------------------------------------------------
      // RECURRING FAILURE
      // ---------------------------------------------------------
      if (event.event === "invoice.payment_failed") {
        const planCode = event.data.plan?.plan_code;

        if (!planCode) {
          logger.error(
            "Missing plan_code in payment_failed event:",
            event.data
          );
          res.status(200).send("Missing plan_code");
          return;
        }

        const planDoc = await db
          .collection("recurringPlans")
          .doc(planCode)
          .get();

        if (!planDoc.exists) {
          logger.error(
            "No matching recurring plan found for failure:",
            planCode
          );
          res.status(200).send("No matching plan");
          return;
        }

        const plan = planDoc.data();
        if (!plan) {
          logger.error("Recurring plan document is empty:", planCode);
          res.status(200).send("Invalid plan document");
          return;
        }

        const donorEmail = event.data.customer.email;
        const amount = event.data.amount / 100;
        const invoiceNumber = event.data.invoice_number;

        // CASE 1: FIRST PAYMENT FAILED
        if (plan.status === "pending") {
          await planDoc.ref.update({
            status: "failed",
            failedAt: new Date(),
          });

          logger.info(`Recurring plan ${planCode} first payment FAILED`);
          res.status(200).send("First recurring payment failed");
          return;
        }

        // CASE 2: SUBSEQUENT PAYMENT FAILED
        await db.collection("donations").add({
          donorUid: plan.donorUid,
          donorEmail,
          childId: plan.childId,
          orphanageId: plan.orphanageId,
          planCode,
          amount,
          status: "failed",
          recurring: true,
          interval: plan.interval,
          createdAt: new Date(),
          paystackRef: invoiceNumber,
          cycle: invoiceNumber,
        });

        logger.info(`Recurring cycle FAILED for plan ${planCode}`);
        res.status(200).send("Recurring cycle failed");
      }

      // ---------------------------------------------------------
      // ONE-OFF FAILURE
      // ---------------------------------------------------------
      if (event.event === "charge.failed") {
        const ref = event.data.reference;
        const snapshot = await db
          .collection("donations")
          .where("paystackRef", "==", ref)
          .get();

        snapshot.forEach((doc) => {
          doc.ref.update({ status: "failed", updatedAt: new Date() });
        });
      }

      res.status(200).send("Webhook processed");
    } catch (error) {
      logger.error("Webhook error", error);
      res.status(500).send("Internal error");
    }
  }
);
