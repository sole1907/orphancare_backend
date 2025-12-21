import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { auth, db } from "./lib/firebaseAdmin";
import Brevo from "sib-api-v3-sdk";
import { defineSecret } from "firebase-functions/params";

const brevoApiKey = defineSecret("BREVO_API_KEY");

export const sendAccountOtp = onDocumentWritten(
  {
    region: "europe-west1",
    document: "orphanages/{orphanageId}",
    secrets: [brevoApiKey],
  },
  async (event) => {
    const before = event.data?.before?.data() as any | undefined;
    const after = event.data?.after?.data() as any | undefined;

    if (!after) {
      logger.info("No after data; exiting sendAccountOtp.");
      return;
    }

    const orphanageId = event.params.orphanageId;
    const prevStatus = before?.accountVerificationStatus;
    const newStatus = after.accountVerificationStatus;

    // Only act when status transitions to "otp_pending"
    if (newStatus !== "otp_pending" || prevStatus === "otp_pending") {
      logger.info(
        `No otp_pending transition for orphanage ${orphanageId}; prev=${prevStatus}, new=${newStatus}`
      );
      return;
    }

    logger.info(
      `accountVerificationStatus changed to otp_pending for orphanage ${orphanageId}`
    );

    try {
      // Get admin email using adminUid stored on the orphanage doc
      const adminUid = after.adminUid as string | undefined;
      if (!adminUid) {
        logger.error(
          `No adminUid found on orphanage ${orphanageId}; cannot send OTP.`
        );
        return;
      }

      const userRecord = await auth.getUser(adminUid);
      const email = userRecord.email;
      if (!email) {
        logger.error(
          `Admin user ${adminUid} has no email; cannot send OTP for orphanage ${orphanageId}.`
        );
        return;
      }

      // Generate OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

      // Save OTP + expiry on the orphanage doc
      await db.collection("orphanages").doc(orphanageId).update({
        accountOtp: otp,
        accountOtpExpires: expiresAt,
      });

      // Configure Brevo client
      const client = Brevo.ApiClient.instance;
      client.authentications["api-key"].apiKey = brevoApiKey.value();
      const apiInstance = new Brevo.TransactionalEmailsApi();

      // Send email
      await apiInstance.sendTransacEmail({
        sender: {
          email: `${process.env.SENDER_EMAIL || "sola.akanmu@gmail.com"}`,
          name: `${process.env.SENDER_NAME || "Sola"}`,
        },
        to: [{ email }],
        subject: "Verify your bank account details",
        htmlContent: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; background-color: #f9f9f9; border-radius: 8px;">
            <h2 style="color: #1e3a8a;">Verify Your Bank Account</h2>
            <p>Hello,</p>
            <p>We received a request to update your bank account details on <strong>Orphancare</strong>.</p>
            <p>Please use the OTP below to confirm this change:</p>
            <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px; margin: 16px 0;">${otp}</p>
            <p>This code will expire in <strong>5 minutes</strong>.</p>
            <p>If you did not request this change, please contact our support team immediately.</p>
            <p style="margin-top: 24px; font-size: 12px; color: #555;">If you have any questions, contact us at support@orphancare.org</p>
          </div>
        `,
      });

      logger.info(`OTP email sent to ${email} for orphanage ${orphanageId}`);
    } catch (error) {
      logger.error("Error in sendAccountOtp", error);
    }
  }
);
