import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import * as crypto from "crypto";
import fetch from "node-fetch";

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

        snapshot.forEach((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
          doc.ref.update({ status: "success", updatedAt: new Date() });
        });
      }

      // ---------------------------------------------------------
      // RECURRING SUCCESS — APPLY SPLIT HERE
      // ---------------------------------------------------------
      if (event.event === "invoice.payment_succeeded") {
        const planId = event.data.plan.id;
        const chargeId = event.data.id; // Paystack charge ID
        const donorEmail = event.data.customer.email;
        const amount = event.data.amount / 100;
        const invoiceNumber = event.data.invoice_number;

        // 1. Find the original donation record
        const donationSnap = await db
          .collection("donations")
          .where("paystackRef", "==", planId)
          .where("recurring", "==", true)
          .limit(1)
          .get();

        if (donationSnap.empty) {
          logger.error(
            "No matching recurring donation found for plan:",
            planId
          );
          res.status(200).send("No matching donation");
          return;
        }

        const donationDoc = donationSnap.docs[0];
        const donation = donationDoc.data();

        const orphanageId = donation.orphanageId;
        const orphanageAmount = donation.orphanageAmount; // kobo
        const platformAmount = donation.platformAmount; // kobo

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

        const orphanageData = orphanageDoc.data() as any;
        const subaccountCode = orphanageData.subaccountCode;

        if (!subaccountCode) {
          logger.error("Orphanage missing subaccountCode:", orphanageId);
          res.status(200).send("Missing subaccount");
          return;
        }

        // 3. Apply split to this recurring charge
        logger.info("Applying split to recurring charge:", chargeId);

        await fetch(`${PAYSTACK_URI}/transaction/split`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecret.value()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            transaction: chargeId,
            subaccount: subaccountCode,
            share: orphanageAmount, // orphanage share in kobo
          }),
        });

        // 4. Log this cycle
        await db.collection("donations").add({
          donorUid: donation.donorUid,
          donorEmail,
          childId: donation.childId,
          orphanageId,
          planId,
          amount,
          status: "success",
          recurring: true,
          interval: donation.interval,
          createdAt: new Date(),
          paystackRef: invoiceNumber,
          cycle: invoiceNumber,
          orphanageAmount,
          platformAmount,
        });
      }

      // ---------------------------------------------------------
      // RECURRING FAILURE
      // ---------------------------------------------------------
      if (event.event === "invoice.payment_failed") {
        const planId = event.data.plan.id;
        const donorEmail = event.data.customer.email;
        const amount = event.data.amount / 100;
        const invoiceNumber = event.data.invoice_number;

        await db.collection("donations").add({
          donorUid: event.data.metadata?.donorUid || null,
          donorEmail,
          childId: event.data.metadata?.childId || null,
          orphanageId: event.data.metadata?.orphanageId || null,
          planId,
          amount,
          status: "failed",
          recurring: true,
          interval: event.data.plan.interval,
          createdAt: new Date(),
          paystackRef: invoiceNumber,
          cycle: invoiceNumber,
        });
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

        snapshot.forEach((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
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
