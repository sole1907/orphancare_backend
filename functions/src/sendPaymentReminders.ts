// functions/src/sendPaymentReminders.ts
import { onSchedule } from "firebase-functions/v2/scheduler";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import Brevo from "sib-api-v3-sdk";

const brevoApiKey = defineSecret("BREVO_API_KEY");

export const sendPaymentReminders = onSchedule(
  {
    schedule: "every day 09:00",
    timeZone: "Africa/Lagos",
    region: "europe-west1",
    secrets: [brevoApiKey],
  },
  async () => {
    logger.info("sendPaymentReminders triggered");

    // Calculate date 3 days from now
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 3);
    const startOfDay = new Date(targetDate);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    logger.info(
      `Looking for active plans due between ${startOfDay.toISOString()} and ${endOfDay.toISOString()}`
    );

    // Query active plans due in 3 days
    const plansSnapshot = await db
      .collection("recurringPlans")
      .where("status", "==", "active")
      .where("nextChargeAt", ">=", startOfDay)
      .where("nextChargeAt", "<=", endOfDay)
      .get();

    if (plansSnapshot.empty) {
      logger.info("No recurring plans due in 3 days");
      return;
    }

    logger.info(`Found ${plansSnapshot.size} plans due in 3 days`);

    // Configure Brevo client
    const client = Brevo.ApiClient.instance;
    client.authentications["api-key"].apiKey = brevoApiKey.value();
    const apiInstance = new Brevo.TransactionalEmailsApi();

    const today = new Date().toDateString();
    let remindersSent = 0;
    let remindersSkipped = 0;

    // Cache for child and orphanage data
    const childCache = new Map<string, { name: string }>();
    const orphanageCache = new Map<string, { name: string }>();

    for (const doc of plansSnapshot.docs) {
      const plan = doc.data();

      // Skip if already reminded today (prevent duplicates on re-run)
      const lastReminderDate = plan.lastReminderSentAt?.toDate?.();
      if (lastReminderDate && lastReminderDate.toDateString() === today) {
        logger.info(`Skipping plan ${plan.planCode} - already reminded today`);
        remindersSkipped++;
        continue;
      }

      const donorEmail = plan.customerEmail;
      if (!donorEmail) {
        logger.warn(`Plan ${plan.planCode} has no customerEmail, skipping`);
        continue;
      }

      // Get child name
      let childName = "Your sponsored child";
      if (plan.childId) {
        if (childCache.has(plan.childId)) {
          childName = childCache.get(plan.childId)!.name;
        } else {
          const childDoc = await db.collection("children").doc(plan.childId).get();
          const childData = childDoc.data();
          if (childData?.name) {
            childName = childData.name;
            childCache.set(plan.childId, { name: childName });
          }
        }
      }

      // Get orphanage name
      let orphanageName = "the orphanage";
      if (plan.orphanageId) {
        if (orphanageCache.has(plan.orphanageId)) {
          orphanageName = orphanageCache.get(plan.orphanageId)!.name;
        } else {
          const orphanageDoc = await db
            .collection("orphanages")
            .doc(plan.orphanageId)
            .get();
          const orphanageData = orphanageDoc.data();
          if (orphanageData?.name) {
            orphanageName = orphanageData.name;
            orphanageCache.set(plan.orphanageId, { name: orphanageName });
          }
        }
      }

      // Format the charge date
      const chargeDate = plan.nextChargeAt?.toDate?.() || new Date(targetDate);
      const formattedDate = chargeDate.toLocaleDateString("en-NG", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      // Format amount
      const amount = plan.grossAmount || plan.amount || 0;
      const formattedAmount = new Intl.NumberFormat("en-NG", {
        style: "currency",
        currency: "NGN",
      }).format(amount);

      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; background-color: #f9f9f9; border-radius: 8px;">
          <h2 style="color: #1e3a8a; margin-bottom: 16px;">Upcoming Donation Reminder</h2>
          <p>Hello,</p>
          <p>This is a friendly reminder that your recurring donation to <strong>${childName}</strong> at <strong>${orphanageName}</strong> is scheduled for <strong>${formattedDate}</strong>.</p>
          <div style="background-color: #e8f0fe; padding: 16px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; font-size: 18px; color: #1e3a8a;">
              <strong>Amount:</strong> ${formattedAmount}
            </p>
            <p style="margin: 8px 0 0 0; color: #555;">
              <strong>Interval:</strong> ${plan.interval || "Monthly"}
            </p>
          </div>
          <p>Please ensure your card is active and has sufficient funds for a smooth transaction.</p>
          <p>You can manage your recurring donations anytime in the Benevovia app.</p>
          <p style="margin-top: 24px; font-size: 12px; color: #555;">
            Thank you for your continued support! If you have any questions, contact us at support@benevovia.com
          </p>
        </div>
      `;

      try {
        await apiInstance.sendTransacEmail({
          sender: {
            email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
            name: process.env.SENDER_NAME || "Benevovia",
          },
          to: [{ email: donorEmail }],
          subject: "Upcoming Donation Reminder",
          htmlContent,
        });

        // Update lastReminderSentAt to prevent duplicates
        await doc.ref.update({
          lastReminderSentAt: new Date(),
        });

        remindersSent++;
        logger.info(`Reminder sent to ${donorEmail} for plan ${plan.planCode}`);
      } catch (err: any) {
        logger.error(
          `Failed to send reminder for plan ${plan.planCode}: ${err.message || err}`
        );
      }
    }

    logger.info(
      `sendPaymentReminders completed. Sent: ${remindersSent}, Skipped: ${remindersSkipped}`
    );
  }
);
