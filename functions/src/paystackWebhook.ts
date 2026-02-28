// functions/src/paystackWebhook.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import * as crypto from "crypto";
import { computeNextChargeAt } from "./lib/chargeAuthorization";
import { FieldValue } from "firebase-admin/firestore";
import { encryptPII, PIIFieldType } from "./lib/encryption";
import {
  sendDonationThankYouEmail,
  sendRecurringChargeConfirmationEmail,
} from "./lib/emailUtils";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");
const devEncryptionKey = defineSecret("DEV_ENCRYPTION_KEY");
const brevoApiKey = defineSecret("BREVO_API_KEY");

export const paystackWebhook = onRequest(
  { region: "europe-west1", secrets: [paystackSecret, devEncryptionKey, brevoApiKey] },
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
      const isRecurring =
        event.data.metadata?.recurring === true ||
        event.data.metadata?.recurring === "true";
      if (event.event === "charge.success" && isRecurring) {
        await handleRecurringChargeSuccess(event, brevoApiKey.value());
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

        if (snapshot.empty) {
          logger.error(
            `One-off charge.success with no matching donation intent. ref=${ref}`,
          );
        }

        // Update donation status and donor lifetime donations
        for (const doc of snapshot.docs) {
          const donationData = doc.data();
          await doc.ref.update({ status: "success", updatedAt: new Date() });

          // Increment donor's lifetime donations
          if (donationData.donorUid) {
            const donorRef = db.collection("donors").doc(donationData.donorUid);
            const amount = donationData.baseAmount || donationData.amount || 0;
            await donorRef.update({
              lifetimeDonations: FieldValue.increment(amount),
              lifetimeDonationCount: FieldValue.increment(1),
              lastDonationAt: new Date(),
            });
            logger.info(
              `Updated lifetimeDonations for donor ${donationData.donorUid} by ${amount}`,
            );
          }

          // Send thank you email for one-off donation
          try {
            const donorEmail = donationData.donorEmail || event.data.customer?.email;
            if (donorEmail) {
              // Fetch child and orphanage names
              let childName = "a child in need";
              let orphanageName = "the orphanage";

              if (donationData.childId) {
                const childDoc = await db.collection("children").doc(donationData.childId).get();
                if (childDoc.exists) {
                  childName = childDoc.data()?.name || childName;
                }
              }

              if (donationData.orphanageId) {
                const orphanageDoc = await db.collection("orphanages").doc(donationData.orphanageId).get();
                if (orphanageDoc.exists) {
                  orphanageName = orphanageDoc.data()?.name || orphanageName;
                }
              }

              await sendDonationThankYouEmail({
                donorEmail,
                childName,
                orphanageName,
                amount: donationData.baseAmount || donationData.amount || 0,
                tipAmount: donationData.tipAmount || 0,
                processorFee: donationData.paystackFee || 0,
                isRecurring: false,
                brevoApiKey: brevoApiKey.value(),
              });

              logger.info(`Thank you email sent for one-off donation to ${donorEmail}`);
            }
          } catch (emailError) {
            logger.error("Failed to send one-off donation thank you email", emailError);
            // Don't fail the webhook if email fails
          }
        }

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
            `charge.failed with no matching donation intent. ref=${ref}`,
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
  },
);

async function handleRecurringChargeSuccess(event: any, brevoApiKeyValue: string) {
  const data = event.data;
  const ref = data.reference;
  const donorEmail = data.customer.email;
  const grossAmount = data.amount / 100;

  const { donorUid, childId, orphanageId, planCode } = data.metadata;

  logger.info(
    `Recurring charge.success: ref=${ref}, donorUid=${donorUid}, childId=${childId}, orphanageId=${orphanageId}, planCode=${planCode}`,
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
      `Recurring plan not found for charge.success. planCode=${planCode}, donorUid=${donorUid}, childId=${childId}, orphanageId=${orphanageId}`,
    );
    return;
  }

  const plan = planDoc.data();
  if (!plan) {
    logger.error(
      `Recurring plan document missing. planCode=${planCode}, donorUid=${donorUid}`,
    );
    return;
  }

  // 2. Save authorizationCode if first time (must be reusable)
  const authorizationCode = data.authorization.authorization_code;
  const isReusable = data.authorization.reusable === true;
  const isFirstCharge = !plan.authorizationCode_encrypted;

  if (isFirstCharge) {
    if (!isReusable) {
      logger.error(
        `Authorization is not reusable. Cannot use for recurring. planCode=${plan.planCode}`,
      );
      await planDoc.ref.update({
        status: "failed",
        lastError: "Card authorization is not reusable",
      });
      return;
    }

    const nextChargeAt = computeNextChargeAt(new Date(), plan.interval, plan.preferredPaymentDay);

    // Encrypt the authorization code before storing
    const authCodeEncrypted = await encryptPII(
      authorizationCode,
      PIIFieldType.AUTHORIZATION_CODE,
    );

    await planDoc.ref.update({
      authorizationCode_encrypted: authCodeEncrypted,
      status: "active",
      activatedAt: new Date(),
      nextChargeAt,
    });
  }

  // 3. Handle donation: update pending (first charge) or create new (subsequent charges)
  let donationRef: any;

  if (isFirstCharge) {
    // First, try to find an existing donation by the Paystack reference (most reliable)
    const refSnapshot = await db
      .collection("donations")
      .where("paystackRef", "==", ref)
      .limit(1)
      .get();

    if (!refSnapshot.empty) {
      const existingDoc = refSnapshot.docs[0];
      donationRef = existingDoc.ref;

      // Update the existing donation with webhook data
      await donationRef.update({
        status: "success",
        splitStatus: "success",
        updatedAt: new Date(),
      });

      logger.info(
        `Updated initial donation by paystackRef: donationId=${existingDoc.id}, planCode=${plan.planCode}`,
      );
    } else {
      // Last fallback: create a new donation (should be rare)
      logger.warn(
        `No pending donation found for first charge. Creating new. planCode=${plan.planCode}`,
      );
      donationRef = await db.collection("orphaned_donations").add({
        donorUid,
        donorEmail,
        childId,
        orphanageId,
        planCode: plan.planCode,
        amount: grossAmount,
        grossAmount,
        baseAmount: plan.baseAmount || 0,
        tipAmount: plan.tipAmount || 0,
        tipPercent: plan.tipPercent || 0,
        netAmount: plan.netAmount || 0,
        paystackFee: plan.paystackFeeEstimate || 0,
        orphanagePayout: plan.orphanageAmount,
        platformPayout: plan.platformAmount,
        status: "success",
        recurring: true,
        interval: plan.interval,
        createdAt: new Date(),
        paystackRef: ref,
        splitStatus: "success",
      });

      logger.info(
        `Recurring donation created (fallback new): donationId=${donationRef.id}, planCode=${plan.planCode}`,
      );
    }
  } else {
    // Subsequent charges: create new donation entry
    donationRef = await db.collection("donations").add({
      donorUid,
      donorEmail,
      childId,
      orphanageId,
      planCode: plan.planCode,
      amount: grossAmount,
      grossAmount,
      baseAmount: plan.baseAmount || 0,
      tipAmount: plan.tipAmount || 0,
      tipPercent: plan.tipPercent || 0,
      netAmount: plan.netAmount || 0,
      paystackFee: plan.paystackFeeEstimate || 0,
      orphanagePayout: plan.orphanageAmount,
      platformPayout: plan.platformAmount,
      status: "success",
      recurring: true,
      interval: plan.interval,
      createdAt: new Date(),
      paystackRef: ref,
      splitStatus: "success",
    });

    logger.info(
      `Recurring donation logged (subsequent charge): donationId=${donationRef.id}, planCode=${plan.planCode}`,
    );
  }

  // 3b. Update donor's lifetime donations
  if (donorUid) {
    const donorRef = db.collection("donors").doc(donorUid);
    const amount = plan.baseAmount || grossAmount || 0;
    await donorRef.update({
      lifetimeDonations: FieldValue.increment(amount),
      lifetimeDonationCount: FieldValue.increment(1),
      lastDonationAt: new Date(),
    });
    logger.info(
      `Updated lifetimeDonations for donor ${donorUid} by ${amount} (recurring)`,
    );
  }

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
    `Payout ledger entry created for donationId=${donationRef.id}, orphanageId=${orphanageId}`,
  );

  // 5. Send thank you / confirmation email
  try {
    // Fetch child and orphanage names
    let childName = "a child in need";
    let orphanageName = "the orphanage";

    if (childId) {
      const childDoc = await db.collection("children").doc(childId).get();
      if (childDoc.exists) {
        childName = childDoc.data()?.name || childName;
      }
    }

    if (orphanageId) {
      const orphanageDoc = await db.collection("orphanages").doc(orphanageId).get();
      if (orphanageDoc.exists) {
        orphanageName = orphanageDoc.data()?.name || orphanageName;
      }
    }

    // Get the next charge date - for first charge it was computed earlier, for subsequent we compute now
    let nextChargeAt: Date;
    if (isFirstCharge) {
      // For first charge, nextChargeAt was computed and stored during plan activation
      nextChargeAt = computeNextChargeAt(new Date(), plan.interval, plan.preferredPaymentDay);
    } else {
      // For subsequent charges, compute the next charge date from now
      // Also update the plan's nextChargeAt for subsequent charges
      nextChargeAt = computeNextChargeAt(new Date(), plan.interval, plan.preferredPaymentDay);
      await planDoc.ref.update({
        nextChargeAt,
        lastChargeAt: new Date(),
        retryCount: 0, // Reset retry count on successful charge
      });
    }

    const amount = plan.baseAmount || grossAmount || 0;
    const tipAmount = plan.tipAmount || 0;
    const processorFee = plan.paystackFeeEstimate || 0;

    if (isFirstCharge) {
      // First charge: send thank you for starting recurring donation
      await sendDonationThankYouEmail({
        donorEmail,
        childName,
        orphanageName,
        amount,
        tipAmount,
        processorFee,
        isRecurring: true,
        interval: plan.interval,
        nextChargeDate: nextChargeAt,
        brevoApiKey: brevoApiKeyValue,
      });
      logger.info(`Thank you email sent for first recurring donation to ${donorEmail}`);
    } else {
      // Subsequent charge: send confirmation email
      await sendRecurringChargeConfirmationEmail({
        donorEmail,
        childName,
        orphanageName,
        amount,
        tipAmount,
        processorFee,
        interval: plan.interval,
        nextChargeDate: nextChargeAt,
        brevoApiKey: brevoApiKeyValue,
      });
      logger.info(`Recurring charge confirmation email sent to ${donorEmail}`);
    }
  } catch (emailError) {
    logger.error("Failed to send recurring donation email", emailError);
    // Don't fail the webhook if email fails
  }
}
