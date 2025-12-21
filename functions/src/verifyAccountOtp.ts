import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";

export const verifyAccountOtp = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    logger.info("Incoming headers:\n" + JSON.stringify(req.headers, null, 2));

    const allowedOrigins = [
      "https://orphancare-93b41.web.app",
      "http://localhost:3000",
    ];
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Origin, Accept"
    );

    if (req.method === "OPTIONS") {
      logger.info("Preflight request received FROM ", origin);
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    try {
      logger.info("verifyAccountOtp triggered");

      // Auth check
      let decoded;
      try {
        decoded = await verifyAuth(req, {
          requiredRoles: ["orphanageAdmin"],
        });
        logger.info(`verifyAccountOtp triggered by ${decoded.uid}`);
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 500).send(err.message || "Internal error");
        return;
      }

      const { orphanageId, otp } = req.body;

      if (!orphanageId || !otp) {
        logger.error("Missing orphanageId or otp");
        res.status(400).json({ error: "Missing orphanageId or otp" });
        return;
      }

      const ref = db.collection("orphanages").doc(orphanageId);
      const snap = await ref.get();

      if (!snap.exists) {
        logger.error(`Orphanage ${orphanageId} not found`);
        res.status(404).json({ error: "Orphanage not found" });
        return;
      }

      const data = snap.data() as any;

      if (!data.accountOtp || !data.accountOtpExpires) {
        logger.error("No OTP found on orphanage doc");
        res.status(400).json({ error: "No OTP found. Please resend." });
        return;
      }

      if (Date.now() > data.accountOtpExpires) {
        logger.error("OTP expired");
        res
          .status(400)
          .json({ error: "OTP expired. Please request a new one." });
        return;
      }

      if (otp !== data.accountOtp) {
        logger.error("Invalid OTP");
        res.status(400).json({ error: "Invalid OTP" });
        return;
      }

      // OTP valid → move to pending_admin_review
      await ref.update({
        accountOtp: null,
        accountOtpExpires: null,
        accountVerificationStatus: "pending",
      });

      logger.info(
        `OTP verified for orphanage ${orphanageId}. Status set to pending.`
      );

      res.json({ success: true });
    } catch (error) {
      logger.error("verifyAccountOtp error", error);
      res.status(500).json({ error: "Internal error" });
    }
  }
);
