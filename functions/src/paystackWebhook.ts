import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import * as crypto from "crypto";

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

      const event = req.body;

      // ✅ Verify signature
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

      // ✅ Handle one-off transaction success
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

      // ✅ Handle recurring subscription payment (create new record each cycle)
      if (event.event === "invoice.payment_succeeded") {
        const planId = event.data.plan.id;
        const donorEmail = event.data.customer.email;
        const amount = event.data.amount / 100; // Paystack sends kobo
        const invoiceNumber = event.data.invoice_number;

        await db.collection("donations").add({
          donorUid: event.data.metadata?.donorUid || null,
          donorEmail,
          childId: event.data.metadata?.childId || null,
          orphanageId: event.data.metadata?.orphanageId || null,
          planId,
          amount,
          status: "success",
          recurring: true,
          interval: event.data.plan.interval, // monthly, quarterly, yearly
          createdAt: new Date(),
          paystackRef: invoiceNumber,
          cycle: invoiceNumber, // unique per cycle
        });
      }

      // ✅ Handle recurring subscription failure (create new record each cycle)
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

      // ✅ Handle one-off failure
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
