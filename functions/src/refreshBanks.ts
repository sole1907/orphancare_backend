import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { defineSecret } from "firebase-functions/params";
import fetch from "node-fetch";
import { verifyAuth } from "./lib/authUtils";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

export const refreshBanks = onRequest(
  { region: "europe-west1", secrets: [paystackSecret] },
  async (req, res) => {
    // CORS setup
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
      res.status(204).send("");
      return;
    }

    try {
      logger.info("refreshBanks triggered");

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

      // Ensure only super admins can call this
      const role = req.headers["x-user-role"]; // you can set this from your portal app
      if (role !== "superAdmin") {
        res.status(403).send("Forbidden");
        return;
      }

      const response = await fetch(
        "https://api.paystack.co/bank?country=nigeria",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${paystackSecret.value()}`,
            "Content-Type": "application/json",
          },
        }
      );

      const result = await response.json();
      const banks = result.data;

      const batch = db.batch();
      banks.forEach((bank: any) => {
        const ref = db.collection("banks").doc(bank.code);
        batch.set(
          ref,
          {
            name: bank.name,
            code: bank.code,
            slug: bank.slug,
            longcode: bank.longcode,
            country: bank.country,
            currency: bank.currency,
            type: bank.type,
            updatedAt: new Date(),
          },
          { merge: true }
        );
      });

      await batch.commit();
      res.json({ message: "Bank list refreshed", count: banks.length });
    } catch (error) {
      logger.error("Bank refresh error", error);
      res.status(500).send("Internal error");
    }
  }
);
