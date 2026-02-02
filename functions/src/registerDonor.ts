import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { auth, db } from "./lib/firebaseAdmin";
import Brevo from "sib-api-v3-sdk";
import { defineSecret } from "firebase-functions/params";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import {
  encryptPII,
  createBlindIndex,
  encryptDeterministic,
  PIIFieldType,
} from "./lib/encryption";

const brevoApiKey = defineSecret("BREVO_API_KEY");
const devEncryptionKey = defineSecret("DEV_ENCRYPTION_KEY");
const blindIndexSalt = defineSecret("BLIND_INDEX_SALT");

export const registerDonor = onRequest(
  { region: "europe-west1", secrets: [brevoApiKey, devEncryptionKey, blindIndexSalt] },
  async (req, res) => {
    logger.info("Incoming headers:\n" + JSON.stringify(req.headers, null, 2));

    if (handleCors(req, res, allowedOrigins)) return;

    try {
      logger.info("registerDonor triggered");
      const {
        email,
        password,
        name,
        phone,
        country,
        donorBirthdayMonth,
        donorBirthdayDay,
        donorHobbies,
      } = req.body;

      if (!email || !password) {
        res.status(400).send("Missing email or password");
        logger.error("Missing email or password");
        return;
      }

      // Create or fetch user
      let user;
      try {
        user = await auth.getUserByEmail(email);
        logger.info(`User already exists: ${user.uid}`);
      } catch {
        user = await auth.createUser({
          email,
          password,
          displayName: name,
        });
        logger.info(`New donor created: ${user.uid}`);
      }

      // Assign donor claim
      await auth.setCustomUserClaims(user.uid, { donor: true });

      // Encrypt PII fields
      const [nameEncrypted, emailEncrypted, phoneEncrypted] = await Promise.all([
        name ? encryptPII(name, PIIFieldType.NAME) : null,
        encryptPII(email, PIIFieldType.EMAIL),
        phone ? encryptPII(phone, PIIFieldType.PHONE) : null,
      ]);

      // Build donor record with encrypted PII
      const donorData: any = {
        // Encrypted fields
        name_encrypted: nameEncrypted,
        email_encrypted: emailEncrypted,
        phone_encrypted: phoneEncrypted,
        // Blind indexes for searching
        email_blind_index: createBlindIndex(email),
        phone_deterministic: phone ? encryptDeterministic(phone) : null,
        // Non-PII fields stored as-is
        country,
        status: "inactive",
        createdAt: new Date(),
        pushNotificationsEnabled: true,
      };

      // Add optional fields if provided
      if (donorBirthdayMonth) donorData.donorBirthdayMonth = donorBirthdayMonth;
      if (donorBirthdayDay) donorData.donorBirthdayDay = donorBirthdayDay;
      if (donorHobbies && Array.isArray(donorHobbies)) {
        donorData.donorHobbies = donorHobbies;
      }

      // Save donor record in Firestore
      await db.collection("donors").doc(user.uid).set(donorData);

      // Generate custom verification link
      const actionCodeSettings = {
        url: `${
          process.env.DONOR_VERIFICATION_REDIRECT_URL ||
          "https://localhost:3000/donor-verified"
        }?uid=${user.uid}&email=${encodeURIComponent(email)}`,
        handleCodeInApp: true,
      };

      const link = await auth.generateEmailVerificationLink(
        email,
        actionCodeSettings
      );

      // Send via Brevo
      const client = Brevo.ApiClient.instance;
      client.authentications["api-key"].apiKey = brevoApiKey.value();
      const apiInstance = new Brevo.TransactionalEmailsApi();

      await apiInstance.sendTransacEmail({
        sender: {
          email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
          name: process.env.SENDER_NAME || "Sola",
        },
        to: [{ email }],
        subject: "Verify your donor account",
        htmlContent: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; background-color: #f9f9f9; border-radius: 8px;">
            <h2 style="color: #1e3a8a;">Welcome to Orphancare</h2>
            <p>Hello ${name || ""},</p>
            <p>Please click the button below to verify your email and activate your donor account:</p>
            <a href="${link}" style="display:inline-block;padding:12px 24px;background-color:#1e3a8a;color:white;text-decoration:none;border-radius:4px;margin-top:12px;">Verify Email</a>
            <p style="margin-top: 24px; font-size: 12px; color: #555;">If you have any questions, contact us at support@orphancare.org</p>
          </div>
        `,
      });

      logger.info(`Verification email sent to ${email}`);
      res.status(200).send("Donor registered, verification email sent");
    } catch (error) {
      logger.error("Donor registration error", error);
      res.status(500).send("Internal error");
    }
  }
);
