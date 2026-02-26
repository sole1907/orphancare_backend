import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { auth, db } from "./lib/firebaseAdmin";
import Brevo from "sib-api-v3-sdk";
import { defineSecret } from "firebase-functions/params";
import { hashOTP } from "./lib/encryption";

const brevoApiKey = defineSecret("BREVO_API_KEY");
const devEncryptionKey = defineSecret("DEV_ENCRYPTION_KEY");

export const notifyAccountStatusChange = onDocumentWritten(
  {
    region: "europe-west1",
    document: "orphanages/{orphanageId}",
    secrets: [brevoApiKey, devEncryptionKey],
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

    // Get orphanage admin email
    const adminUid = after.adminUid as string | undefined;
    if (!adminUid) {
      logger.error(`No adminUid found on orphanage ${orphanageId}`);
      return;
    }

    const userRecord = await auth.getUser(adminUid);
    const orphanageEmail = userRecord.email;
    if (!orphanageEmail) {
      logger.error(`Admin user ${adminUid} has no email`);
      return;
    }

    // Configure Brevo client
    const client = Brevo.ApiClient.instance;
    client.authentications["api-key"].apiKey = brevoApiKey.value();
    const apiInstance = new Brevo.TransactionalEmailsApi();

    // Shared email wrapper
    const wrapEmail = (title: string, bodyHtml: string) => `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; background-color: #f9f9f9; border-radius: 8px;">
        <h2 style="color: #1e3a8a; margin-bottom: 16px;">${title}</h2>
        ${bodyHtml}
        <p style="margin-top: 24px; font-size: 12px; color: #555;">
          If you have any questions, contact us at support@benevovia.com
        </p>
      </div>
    `;

    // --- CASE 1: OTP PENDING ---
    if (newStatus === "otp_pending" && prevStatus !== "otp_pending") {
      logger.info(`Sending OTP for orphanage ${orphanageId}`);

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 5 * 60 * 1000;

      // Hash OTP before storing (more secure than plaintext)
      const otpHash = hashOTP(otp);

      await db.collection("orphanages").doc(orphanageId).update({
        accountOtpHash: otpHash,
        accountOtpExpires: expiresAt,
      });

      const htmlContent = wrapEmail(
        "Verify Your Bank Account",
        `
          <p>Hello,</p>
          <p>We received a request to update your bank account details on <strong>Benevovia</strong>.</p>
          <p>Please use the OTP below to confirm this change:</p>
          <p style="font-size: 28px; font-weight: bold; letter-spacing: 4px; margin: 20px 0; color: #1e3a8a;">
            ${otp}
          </p>
          <p>This code will expire in <strong>5 minutes</strong>.</p>
          <p>If you did not request this change, please contact our support team immediately.</p>
        `
      );

      await apiInstance.sendTransacEmail({
        sender: {
          email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
          name: process.env.SENDER_NAME || "Benevovia",
        },
        to: [{ email: orphanageEmail }],
        subject: "Verify your bank account details",
        htmlContent,
      });

      logger.info(`OTP email sent to ${orphanageEmail}`);
      return;
    }

    // --- CASE 2: PENDING (notify admin) ---
    if (newStatus === "pending" && prevStatus !== "pending") {
      logger.info(
        `Sending admin notification for pending account ${orphanageId}`
      );

      const adminEmail = process.env.ADMIN_EMAIL;
      if (!adminEmail) {
        logger.error("ADMIN_EMAIL is not set in environment variables.");
        return;
      }

      const htmlContent = wrapEmail(
        "New Bank Account Verification Request",
        `
          <p>Hello Admin,</p>
          <p>A new bank account verification request has been submitted and is awaiting your review.</p>
          <p><strong>Orphanage:</strong> ${after.name}</p>
          <p>Please visit the Action Center on the Benevovia dashboard to approve or reject this request.</p>
        `
      );

      await apiInstance.sendTransacEmail({
        sender: {
          email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
          name: process.env.SENDER_NAME || "Benevovia",
        },
        to: [{ email: adminEmail }],
        subject: "New bank account verification request",
        htmlContent,
      });

      logger.info(`Admin notification sent to ${adminEmail}`);
      return;
    }

    // --- CASE 3: APPROVED ---
    if (newStatus === "approved" && prevStatus !== "approved") {
      logger.info(`Sending approval email for orphanage ${orphanageId}`);

      const htmlContent = wrapEmail(
        "Your Bank Account Has Been Approved",
        `
          <p>Hello,</p>
          <p>Great news! Your bank account details have been successfully approved.</p>
          <p>You can now receive payouts on <strong>Benevovia</strong>.</p>
          <p>Thank you for completing your verification.</p>
        `
      );

      await apiInstance.sendTransacEmail({
        sender: {
          email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
          name: process.env.SENDER_NAME || "Benevovia",
        },
        to: [{ email: orphanageEmail }],
        subject: "Your bank account has been approved",
        htmlContent,
      });

      logger.info(`Approval email sent to ${orphanageEmail}`);
      return;
    }

    // --- CASE 4: REJECTED ---
    if (newStatus === "rejected" && prevStatus !== "rejected") {
      logger.info(`Sending rejection email for orphanage ${orphanageId}`);

      const htmlContent = wrapEmail(
        "Your Bank Account Could Not Be Approved",
        `
          <p>Hello,</p>
          <p>Unfortunately, we were unable to approve your bank account details.</p>
          <p>Please review your information and try again.</p>
          <p>If you believe this is an error, feel free to reach out to our support team.</p>
        `
      );

      await apiInstance.sendTransacEmail({
        sender: {
          email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
          name: process.env.SENDER_NAME || "Benevovia",
        },
        to: [{ email: orphanageEmail }],
        subject: "Your bank account could not be approved",
        htmlContent,
      });

      logger.info(`Rejection email sent to ${orphanageEmail}`);
      return;
    }

    logger.info("No relevant status transition; no email sent.");
  }
);
