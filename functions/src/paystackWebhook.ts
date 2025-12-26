import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import * as crypto from "crypto";
import fetch from "node-fetch";
import Brevo from "sib-api-v3-sdk";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");
const brevoApiKey = defineSecret("BREVO_API_KEY");

export const paystackWebhook = onRequest(
  { region: "europe-west1", secrets: [paystackSecret, brevoApiKey] },
  async (req, res): Promise<void> => {
    try {
      const forwardedFor = req.headers["x-forwarded-for"];

      const ip =
        typeof forwardedFor === "string"
          ? forwardedFor.split(",")[0].trim()
          : Array.isArray(forwardedFor)
          ? forwardedFor[0].trim()
          : undefined;
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

      logger.info(`Webhook event body: ${JSON.stringify(event, null, 2)}`);

      // ---------------------------------------------------------
      // SHARED HANDLER FOR RECURRING SUCCESS (FIRST + SUBSEQUENT)
      // ---------------------------------------------------------
      const handleRecurringSuccess = async (
        planCode: string,
        chargeId: number,
        donorEmail: string,
        grossAmount: number,
        cycleRef: string
      ) => {
        // 1. Fetch recurring plan
        const planDoc = await db
          .collection("recurringPlans")
          .doc(planCode)
          .get();
        if (!planDoc.exists) {
          logger.error("No matching recurring plan found:", planCode);
          return;
        }

        const plan = planDoc.data();
        if (!plan) {
          logger.error("Recurring plan document empty:", planCode);
          return;
        }

        const orphanageId = plan.orphanageId;
        const expectedNet = plan.netAmount;
        const orphanageAmount = plan.orphanageAmount;
        const platformAmount = plan.platformAmount;

        // 2. Fetch orphanage subaccount
        const orphanageDoc = await db
          .collection("orphanages")
          .doc(orphanageId)
          .get();
        if (!orphanageDoc.exists) {
          logger.error("Orphanage not found:", orphanageId);
          return;
        }

        const orphanageData = orphanageDoc.data();
        const subaccountCode = orphanageData?.subaccountCode;

        if (!subaccountCode) {
          logger.error("Missing subaccountCode for orphanage:", orphanageId);
          return;
        }

        // 3. Compute actual fee
        const netReceived = grossAmount;
        const actualFee = grossAmount - netReceived;
        const difference = expectedNet - netReceived;
        const diffKobo = Math.round(difference * 100);

        // 4. Adjust payouts
        let orphanagePayout = orphanageAmount;
        let platformPayout = platformAmount;

        if (diffKobo > 0) {
          if (platformPayout >= diffKobo) {
            platformPayout -= diffKobo;
          } else {
            const remaining = diffKobo - platformPayout;
            platformPayout = 0;
            orphanagePayout = Math.max(0, orphanagePayout - remaining);
          }
        }

        // ---------------------------------------------------------
        // 5. ALWAYS CREATE DONATION FIRST (status = pending)
        // ---------------------------------------------------------
        const donationRef = await db.collection("donations").add({
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
          status: "pending", // <-- IMPORTANT
          recurring: true,
          interval: plan.interval,
          createdAt: new Date(),
          paystackRef: cycleRef,
          cycle: cycleRef,
          splitStatus: "pending",
          splitError: null,
          splitAttemptedAt: null,
        });

        // ---------------------------------------------------------
        // 6. APPLY SPLIT (safe logging + safe JSON parsing)
        // ---------------------------------------------------------
        let splitStatus: "success" | "failed" = "failed";
        let splitError: string | null = null;

        try {
          const splitResponse = await fetch(
            `${PAYSTACK_URI}/transaction/split`,
            {
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
            }
          );

          // Log raw response ALWAYS
          const raw = await splitResponse.text();
          logger.error(
            `Paystack split raw response: status=${splitResponse.status}, body=${raw}`
          );

          let splitData: any = null;
          try {
            splitData = JSON.parse(raw);
          } catch {
            logger.error("Failed to parse split response JSON");
          }

          if (!splitResponse.ok) {
            splitStatus = "failed";
            splitError = splitData?.message || raw || "Unknown Paystack error";
          } else {
            splitStatus = "success";
          }
        } catch (err: any) {
          splitError = err.message || "Split request error";
        }

        // ---------------------------------------------------------
        // 7. UPDATE DONATION AFTER SPLIT ATTEMPT
        // ---------------------------------------------------------
        await donationRef.update({
          status: "success", // donation succeeded regardless of split
          splitStatus,
          splitError,
          splitAttemptedAt: new Date(),
        });

        // ---------------------------------------------------------
        // 8. EMAIL ADMIN IF SPLIT FAILED
        // ---------------------------------------------------------
        if (splitStatus === "failed") {
          logger.error(
            `Split failed for donation ${donationRef.id}: ${splitError}`
          );

          const adminEmail = process.env.ADMIN_EMAIL;
          if (adminEmail) {
            const client = Brevo.ApiClient.instance;
            client.authentications["api-key"].apiKey = brevoApiKey.value();
            const apiInstance = new Brevo.TransactionalEmailsApi();

            const wrapEmail = (title: string, bodyHtml: string) => `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; background-color: #f9f9f9; border-radius: 8px;">
          <h2 style="color: #1e3a8a; margin-bottom: 16px;">${title}</h2>
          ${bodyHtml}
          <p style="margin-top: 24px; font-size: 12px; color: #555;">
            If you have any questions, contact us at support@orphancare.org
          </p>
        </div>
      `;

            const htmlContent = wrapEmail(
              "Split Payment Failure",
              `
          <p>Hello Admin,</p>
          <p>A split payment attempt has <strong>failed</strong> during a recurring donation cycle.</p>

          <p><strong>Donation ID:</strong> ${donationRef.id}</p>
          <p><strong>Plan Code:</strong> ${planCode}</p>
          <p><strong>Orphanage:</strong> ${orphanageId}</p>
          <p><strong>Charge ID:</strong> ${chargeId}</p>
          <p><strong>Orphanage Payout:</strong> ₦${(
            orphanagePayout / 100
          ).toFixed(2)}</p>

          <p><strong>Error:</strong> ${splitError}</p>

          <p>Please visit the <strong>Action Center</strong> on the Orphancare dashboard to retry or resolve this split.</p>
        `
            );

            await apiInstance.sendTransacEmail({
              sender: {
                email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
                name: process.env.SENDER_NAME || "Sola",
              },
              to: [{ email: adminEmail }],
              subject: "Split Payment Failure",
              htmlContent,
            });

            logger.info(`Split failure email sent to admin: ${adminEmail}`);
          }
        }

        // ---------------------------------------------------------
        // 9. MARK PLAN ACTIVE IF FIRST PAYMENT
        // ---------------------------------------------------------
        if (plan.status !== "active") {
          await planDoc.ref.update({
            status: "active",
            activatedAt: new Date(),
          });
        }
      };

      // ---------------------------------------------------------
      // FIRST RECURRING PAYMENT (charge.success + plan)
      // ---------------------------------------------------------
      if (event.event === "charge.success" && event.data.plan?.plan_code) {
        await handleRecurringSuccess(
          event.data.plan.plan_code,
          event.data.id,
          event.data.customer.email,
          event.data.amount / 100,
          event.data.reference
        );

        res.status(200).send("First recurring payment processed");
        return;
      }

      // ---------------------------------------------------------
      // SUBSEQUENT RECURRING PAYMENT
      // ---------------------------------------------------------
      if (event.event === "invoice.payment_succeeded") {
        await handleRecurringSuccess(
          event.data.plan.plan_code,
          event.data.id,
          event.data.customer.email,
          event.data.amount / 100,
          event.data.invoice_number
        );

        res.status(200).send("Recurring donation processed");
        return;
      }

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

        res.status(200).send("One-off success processed");
        return;
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
        return;
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

        res.status(200).send("One-off failure processed");
        return;
      }

      res.status(200).send("Webhook processed");
    } catch (error) {
      logger.error("Webhook error", error);
      res.status(500).send("Internal error");
    }
  }
);
