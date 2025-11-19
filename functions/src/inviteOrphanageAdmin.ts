import { onRequest } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import * as logger from "firebase-functions/logger";
import Brevo from "sib-api-v3-sdk";

initializeApp();

export const inviteOrphanageAdmin = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    logger.info("Incoming headers:\n" + JSON.stringify(req.headers, null, 2));

    const allowedOrigins = [
      "https://orphancare-93b41.web.app",
      "http://localhost:3000",
    ];

    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
    }
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
      logger.info("Preflight request received FROM ", origin);
      res.status(204).end("");
      return;
    }

    try {
      logger.info("inviteOrphanageAdmin triggered");
      const { email, orphanageId } = req.body;
      if (!email || !orphanageId) {
        res.status(400).send("Missing email or orphanageId");
        logger.error("Missing email or orphanageId");
        return;
      }

      const auth = getAuth();

      let user;
      try {
        user = await auth.getUserByEmail(email);
      } catch {
        user = await auth.createUser({ email });
      }

      await auth.setCustomUserClaims(user.uid, {
        orphanageAdmin: true,
        orphanageId,
      });

      const actionCodeSettings = {
        url: `${
          process.env.REGISTRATION_REDIRECT_URL ||
          "https://localhost:3000/complete-registration"
        }?email=${encodeURIComponent(email)}`,
        handleCodeInApp: true,
      };

      const link = await auth.generateSignInWithEmailLink(
        email,
        actionCodeSettings
      );

      const client = Brevo.ApiClient.instance;
      client.authentications["api-key"].apiKey = process.env.FIREBASE_CONFIG
        ? JSON.parse(process.env.FIREBASE_CONFIG).brevo?.apikey
        : process.env.brevo_apikey;

      const apiInstance = new Brevo.TransactionalEmailsApi();

      await apiInstance.sendTransacEmail({
        sender: { email: "noreply@orphancare.org", name: "Orphancare" },
        to: [{ email }],
        subject: "Complete your Orphanage Admin registration",
        htmlContent: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; background-color: #f9f9f9; border-radius: 8px;">
            <h2 style="color: #1e3a8a;">Welcome to Orphancare</h2>
            <p>Hello,</p>
            <p>You’ve been invited to manage your orphanage on <strong>HopeBridge</strong>.</p>
            <p>Please click the button below to complete your registration and set your password:</p>
            <a href="${link}" style="display: inline-block; padding: 12px 24px; background-color: #1e3a8a; color: white; text-decoration: none; border-radius: 4px; margin-top: 12px;">Complete Registration</a>
            <p style="margin-top: 24px; font-size: 12px; color: #555;">If you have any questions, contact us at support@hopebridge.org</p>
          </div>
        `,
      });

      logger.info(`Invite sent to ${email}`);
      res.status(200).send("Invite sent");
    } catch (error) {
      logger.error("Invite error", error);
      res.status(500).send("Internal error");
    }
  }
);
