// functions/src/chargeRecurringDonations.ts
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import { chargeAuthorizationForPlan, computeNextChargeAt } from "./lib/chargeAuthorization";
import { getSubaccountCode } from "./lib/paystackUtils";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");
// Include DEV_ENCRYPTION_KEY in this function's `secrets` so encryption helpers
// (e.g. `decryptPII`) that rely on this secret via `defineSecret`
// can access it at runtime. It's used indirectly by
// `chargeAuthorizationForPlan` when decrypting stored authorization codes.
const devEncryptionKey = defineSecret("DEV_ENCRYPTION_KEY");

export const chargeRecurringDonations = onSchedule(
  {
    schedule: "every day 12:00",
    timeZone: "Africa/Lagos",
    region: "europe-west1",
    secrets: [paystackSecret, devEncryptionKey],
  },
  async () => {
    const BATCH_SIZE = 50;
    const MAX_DONATIONS_PER_RUN = 100; // Configurable cap

    const now = new Date();
    logger.info(`chargeRecurringDonations tick at ${now.toISOString()}`);

    const PAYSTACK_URI = process.env.PAYSTACK_URI || "https://api.paystack.co";
    const secret = paystackSecret.value();
    const isProd = process.env.ENV_TYPE === "production";

    let totalProcessed = 0;
    let hasMore = true;

    while (hasMore && totalProcessed < MAX_DONATIONS_PER_RUN) {
      const snapshot = await db
        .collection("recurringPlans")
        .where("status", "==", "active")
        .where("nextChargeAt", "<=", now)
        .limit(BATCH_SIZE)
        .get();

      if (snapshot.empty) {
        if (totalProcessed === 0) {
          logger.info("No recurring plans due for charge");
        }
        hasMore = false;
        break;
      }

      for (const doc of snapshot.docs) {
        const plan = doc.data();
        const planCode = plan.planCode;

        logger.info(`Charging planCode=${planCode}`);

        // Skip daily plans in production (defensive measure)
        if (isProd && plan.interval?.toLowerCase() === "daily") {
          logger.warn(
            `Skipping daily plan ${planCode} in production environment`
          );
          continue;
        }

        // Fetch orphanage subaccount
        const orphanageDoc = await db
          .collection("orphanages")
          .doc(plan.orphanageId)
          .get();
        const orphanageData = orphanageDoc.data();

        const subaccountCode = await getSubaccountCode(orphanageData);
        if (!subaccountCode) {
          logger.error(
            `Orphanage ${plan.orphanageId} has no subaccount. Skipping plan ${planCode}`
          );
          await doc.ref.update({
            lastError: "Orphanage has no subaccount configured",
          });
          continue;
        }

        try {
          await chargeAuthorizationForPlan({
            planDocRef: doc.ref,
            plan,
            PAYSTACK_URI,
            secret,
            subaccountCode,
          });
        } catch (err: any) {
          const currentRetries = plan.retryCount || 0;
          const maxRetries = plan.maxRetries || 3;
          const nextChargeAt = computeNextChargeAt(now, plan.interval);

          if (currentRetries + 1 >= maxRetries) {
            await doc.ref.update({
              status: "paused",
              retryCount: currentRetries + 1,
              lastError: err.message || String(err),
              nextChargeAt,
            });
            // optional: send donor email about paused plan
          } else {
            await doc.ref.update({
              retryCount: currentRetries + 1,
              lastError: err.message || String(err),
              nextChargeAt,
            });
          }
          logger.error(
            `Retry logic: planCode=${plan.planCode}, retryCount=${
              currentRetries + 1
            }, error=${err.message || err}`
          );
        }
      }

      totalProcessed += snapshot.docs.length;

      // If we got fewer than BATCH_SIZE, there are no more
      if (snapshot.docs.length < BATCH_SIZE) {
        hasMore = false;
      }
    }

    if (totalProcessed >= MAX_DONATIONS_PER_RUN) {
      logger.warn(
        `Reached MAX_DONATIONS_PER_RUN cap (${MAX_DONATIONS_PER_RUN}). Some donations may be delayed.`
      );
    }

    logger.info(
      `chargeRecurringDonations completed. Processed ${totalProcessed} plans.`
    );
  }
);
