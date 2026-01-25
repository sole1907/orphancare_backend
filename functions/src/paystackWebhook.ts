// functions/src/paystackWebhook.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import * as crypto from "crypto";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

export const paystackWebhook = onRequest(
  { region: "europe-west1", secrets: [paystackSecret] },
  async (req, res) => {
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

      const event = req.body;

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
      // RECURRING via Charge Authorization (charge.success + metadata.recurring)
      // ---------------------------------------------------------
      if (event.event === "charge.success" && event.data.metadata?.recurring) {
        await handleRecurringChargeSuccess(event);
        res.status(200).send("Recurring donation processed");
        // sendTransacEmail({ ... "Thank you for your recurring donation" ... })
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

        if (snapshot.empty) {
          logger.error(
            `One-off charge.success with no matching donation intent. ref=${ref}`
          );
        }

        snapshot.forEach((doc) => {
          doc.ref.update({ status: "success", updatedAt: new Date() });
        });

        res.status(200).send("One-off success processed");
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

        if (snapshot.empty) {
          logger.error(
            `charge.failed with no matching donation intent. ref=${ref}`
          );
        }

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

async function handleRecurringChargeSuccess(event: any) {
  const data = event.data;
  const ref = data.reference;
  const donorEmail = data.customer.email;
  const grossAmount = data.amount / 100;

  const { donorUid, childId, orphanageId, planCode } = data.metadata;

  logger.info(
    `Recurring charge.success: ref=${ref}, donorUid=${donorUid}, childId=${childId}, orphanageId=${orphanageId}, planCode=${planCode}`
  );

  // 1. Find plan
  const planDoc = planCode
    ? await db.collection("recurringPlans").doc(planCode).get()
    : await db
        .collection("recurringPlans")
        .where("donorUid", "==", donorUid)
        .where("childId", "==", childId)
        .where("orphanageId", "==", orphanageId)
        .limit(1)
        .get()
        .then((snap) => (snap.empty ? null : snap.docs[0]));

  if (!planDoc || !planDoc.exists) {
    logger.error(
      `Recurring plan not found for charge.success. planCode=${planCode}, donorUid=${donorUid}, childId=${childId}, orphanageId=${orphanageId}`
    );
    return;
  }

  const plan = planDoc.data();
  if (!plan) {
    logger.error(
      `Recurring plan document missing. planCode=${planCode}, donorUid=${donorUid}`
    );
    return;
  }

  // 2. Save authorizationCode if first time
  const authorizationCode = data.authorization.authorization_code;
  if (!plan.authorizationCode) {
    await planDoc.ref.update({
      authorizationCode,
      status: "active",
      activatedAt: new Date(),
    });
  }

  // 3. Create donation (always)
  const donationRef = await db.collection("donations").add({
    donorUid,
    donorEmail,
    childId,
    orphanageId,
    planCode: plan.planCode,
    grossAmount,
    orphanagePayout: plan.orphanageAmount,
    platformPayout: plan.platformAmount,
    status: "success",
    recurring: true,
    interval: plan.interval,
    createdAt: new Date(),
    paystackRef: ref,
    splitStatus: "manual_required",
    splitError: "Recurring charges are settled via payout ledger",
  });

  logger.info(
    `Recurring donation logged: donationId=${donationRef.id}, planCode=${plan.planCode}`
  );

  // 4. Create payout ledger entry
  await db.collection("payoutLedger").add({
    orphanageId,
    donationId: donationRef.id,
    planCode: plan.planCode,
    amount: plan.orphanageAmount,
    status: "pending",
    error: null,
    createdAt: new Date(),
    paidAt: null,
  });

  logger.info(
    `Payout ledger entry created for donationId=${donationRef.id}, orphanageId=${orphanageId}`
  );
}
