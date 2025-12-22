import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { auth, db } from "./lib/firebaseAdmin";
import Brevo from "sib-api-v3-sdk";
import { defineSecret } from "firebase-functions/params";

const brevoApiKey = defineSecret("BREVO_API_KEY");

export const notifyAccountStatusChange = onDocumentWritten(
  {
    region: "europe-west1",
    document: "orphanages/{orphanageId}",
    secrets: [brevoApiKey],
  },
  async (event) => {
    const before = event.data?.before?.data() as any | undefined;
    const after = event.data?.after?.data() as any | undefined;

    if (!after) {
      logger.info("No after data; exiting notifyAccountStatusChange.");
      return;
    }

    const orphanageId = event.params.orphanageId;
    const prevStatus = before?.accountVerificationStatus;
    const newStatus = after.accountVerificationStatus;

    logger.info(
      `Status change detected for orphanage ${orphanageId}: ${prevStatus} → ${newStatus}`
    );

    // Get admin email
    const adminUid = after.adminUid as string | undefined;
    if (!adminUid) {
      logger.error(`No adminUid found on orphanage ${orphanageId}`);
      return;
    }

    const userRecord = await auth.getUser(adminUid);
    const email = userRecord.email;
    if (!email) {
      logger.error(`Admin user ${adminUid} has no email`);
      return;
    }

    // Configure Brevo client
    const client = Brevo.ApiClient.instance;
    client.authentications["api-key"].apiKey = brevoApiKey.value();
    const apiInstance = new Brevo.TransactionalEmailsApi();

    // --- CASE 1: OTP PENDING ---
    if (newStatus === "otp_pending" && prevStatus !== "otp_pending") {
      logger.info(`Sending OTP for orphanage ${orphanageId}`);

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 5 * 60 * 1000;

      await db.collection("orphanages").doc(orphanageId).update({
        accountOtp: otp,
        accountOtpExpires: expiresAt,
      });

      await apiInstance.sendTransacEmail({
        sender: {
          email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
          name: process.env.SENDER_NAME || "Sola",
        },
        to: [{ email }],
        subject: "Verify your bank account details",
        htmlContent: `
          <p>Hello,</p>
          <p>Please use the OTP below to verify your bank account details:</p>
          <h2>${otp}</h2>
          <p>This code expires in 5 minutes.</p>
        `,
      });

      logger.info(`OTP email sent to ${email}`);
      return;
    }

    // --- CASE 2: APPROVED ---
    if (newStatus === "approved" && prevStatus !== "approved") {
      logger.info(`Sending approval email for orphanage ${orphanageId}`);

      await apiInstance.sendTransacEmail({
        sender: {
          email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
          name: process.env.SENDER_NAME || "Sola",
        },
        to: [{ email }],
        subject: "Your bank account has been approved",
        htmlContent: `
          <p>Hello,</p>
          <p>Your bank account details have been successfully approved.</p>
          <p>You can now receive payouts on Orphancare.</p>
        `,
      });

      logger.info(`Approval email sent to ${email}`);
      return;
    }

    // --- CASE 3: REJECTED ---
    if (newStatus === "rejected" && prevStatus !== "rejected") {
      logger.info(`Sending rejection email for orphanage ${orphanageId}`);

      await apiInstance.sendTransacEmail({
        sender: {
          email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
          name: process.env.SENDER_NAME || "Sola",
        },
        to: [{ email }],
        subject: "Your bank account could not be approved",
        htmlContent: `
          <p>Hello,</p>
          <p>Unfortunately, your bank account details could not be approved.</p>
          <p>Please review your information and try again.</p>
        `,
      });

      logger.info(`Rejection email sent to ${email}`);
      return;
    }

    logger.info("No relevant status transition; no email sent.");
  }
);
