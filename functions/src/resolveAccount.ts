import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import fetch from "node-fetch";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");

export const resolveAccount = onRequest(
  { region: "europe-west1", secrets: [paystackSecret] },
  async (req, res) => {
    logger.info("Incoming headers:\n" + JSON.stringify(req.headers, null, 2));

    if (handleCors(req, res, allowedOrigins)) return;

    try {
      logger.info("resolveAccount triggered");

      const { accountNumber, bankCode } = req.body;

      if (!accountNumber || !bankCode) {
        logger.error("Missing required fields");
        res.status(400).send("Missing required fields");
        return;
      }

      // --- Auth check ---
      try {
        const decoded = await verifyAuth(req);
        logger.info(`resolveAccount triggered by ${decoded.uid}`);
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 500).send(err.message || "Internal error");
        return;
      }

      // --- Call Paystack ---
      const PAYSTACK_URI =
        process.env.PAYSTACK_URI || "https://api.paystack.co";

      const url = `${PAYSTACK_URI}/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`;

      logger.info(`Resolving account via: ${url}`);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${paystackSecret.value()}`,
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (!data.status) {
        logger.error("Paystack resolve failed", data);
        res.status(400).json({ error: data.message || "Unable to resolve" });
        return;
      }

      const accountName = data.data.account_name;

      logger.info(`Resolved account: ${accountName}`);

      res.json({
        accountName,
        accountNumber,
        bankCode,
      });
    } catch (error) {
      logger.error("Resolve account error", error);
      res.status(500).send("Internal error");
    }
  }
);
