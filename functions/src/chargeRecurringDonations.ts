// functions/src/chargeRecurringDonations.ts
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import fetch from "node-fetch";
import { defineSecret } from "firebase-functions/params";
import { chargeAuthorizationForPlan } from "./lib/chargeAuthorization";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

export const chargeRecurringDonations = onSchedule(
  {
    schedule: "every day 02:00",
    timeZone: "Africa/Lagos",
    region: "europe-west1",
    secrets: [paystackSecret],
  },
  async () => {
    const now = new Date();
    logger.info(`chargeRecurringDonations tick at ${now.toISOString()}`);

    const snapshot = await db
      .collection("recurringPlans")
      .where("status", "==", "active")
      .where("nextChargeAt", "<=", now)
      .limit(50)
      .get();

    if (snapshot.empty) {
      logger.info("No recurring plans due for charge");
      return;
    }

    const PAYSTACK_URI = process.env.PAYSTACK_URI || "https://api.paystack.co";
    const secret = paystackSecret.value();

    for (const doc of snapshot.docs) {
      const plan = doc.data();
      const planCode = plan.planCode;

      logger.info(`Charging planCode=${planCode}`);

      try {
        await chargeAuthorizationForPlan({
          planDocRef: doc.ref,
          plan,
          PAYSTACK_URI,
          secret,
        });
      } catch (err: any) {
        const currentRetries = plan.retryCount || 0;
        const maxRetries = plan.maxRetries || 3;
        if (currentRetries + 1 >= maxRetries) {
          await doc.ref.update({
            status: "paused",
            retryCount: currentRetries + 1,
            lastError: err.message || String(err),
          });
          // optional: send donor email about paused plan
        } else {
          await doc.ref.update({
            retryCount: currentRetries + 1,
            lastError: err.message || String(err),
          });
        }
        logger.error(
          `Retry logic: planCode=${plan.planCode}, retryCount=${
            currentRetries + 1
          }, error=${err.message || err}`
        );
      }
    }
  }
);
