import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { auth, db } from "./lib/firebaseAdmin";
import Brevo from "sib-api-v3-sdk";
import { defineSecret } from "firebase-functions/params";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { wrapEmailContent, SENDER_EMAIL, SENDER_NAME } from "./lib/emailUtils";

const brevoApiKey = defineSecret("BREVO_API_KEY");

export const inviteOrphanageAdmin = onRequest(
  { region: "europe-west1", secrets: [brevoApiKey] },
  async (req, res) => {
    logger.info("Incoming headers:\n" + JSON.stringify(req.headers, null, 2));

    if (handleCors(req, res, allowedOrigins)) return;

    try {
      logger.info("inviteOrphanageAdmin triggered");

      // 🔐 Auth check
      try {
        const decoded = await verifyAuth(req, {
          requiredRoles: ["superAdmin"],
        });
        logger.info(`Invite triggered by ${decoded.uid}`); // ... rest of your logic
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 500).send(err.message || "Internal error");
        return;
      }

      const { email, orphanageId } = req.body;
      if (!email || !orphanageId) {
        res.status(400).send("Missing email or orphanageId");
        logger.error("Missing email or orphanageId");
        return;
      }

      // Check if user already exists
      try {
        await auth.getUserByEmail(email);
        logger.warn(`Invite attempt with existing email: ${email}`);
        res.status(409).send("An account with this email already exists");
        return;
      } catch {
        // User does not exist, proceed with invite
      }

      // Create new user
      const user = await auth.createUser({ email });

      await auth.setCustomUserClaims(user.uid, {
        orphanageAdmin: true,
        orphanageId,
      });

      // Write the orphanage admin UID into the orphanage doc
      await db.doc(`orphanages/${orphanageId}`).update({
        adminUid: user.uid,
      });

      const actionCodeSettings = {
        url: `${
          process.env.REGISTRATION_REDIRECT_URL ||
          "https://localhost:3000/complete-registration"
        }?email=${encodeURIComponent(email)}&orphanageId=${orphanageId}`,
        handleCodeInApp: true,
      };

      const link = await auth.generateSignInWithEmailLink(
        email,
        actionCodeSettings
      );

      const client = Brevo.ApiClient.instance;
      client.authentications["api-key"].apiKey = brevoApiKey.value();

      const apiInstance = new Brevo.TransactionalEmailsApi();

      const emailBodyContent = `
        <h2 style="color: #1e3a8a; margin-bottom: 16px;">Welcome!</h2>
        <p>Hello,</p>
        <p>You've been invited to manage your orphanage on <strong>Benevovia</strong>.</p>
        <p>Please click the button below to complete your registration and set your password:</p>
        <a href="${link}" style="display: inline-block; padding: 12px 24px; background-color: #1e3a8a; color: white; text-decoration: none; border-radius: 4px; margin-top: 12px;">Complete Registration</a>
      `;

      await apiInstance.sendTransacEmail({
        sender: {
          email: SENDER_EMAIL,
          name: SENDER_NAME,
        },
        to: [{ email }],
        subject: "Complete your Orphanage Admin registration",
        htmlContent: wrapEmailContent(emailBodyContent),
      });

      logger.info(`Invite sent to ${email}`);
      res.status(200).send("Invite sent");
    } catch (error) {
      logger.error("Invite error", error);
      res.status(500).send("Internal error");
    }
  }
);
