// functions/src/calculateDonationFee.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { loadFeeConfig, computeGrossAmount } from "./lib/feeEngine";

export const calculateDonationFee = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    try {
      const { baseAmount, tipPercent } = req.body;

      if (typeof baseAmount !== "number" || baseAmount <= 0) {
        res.status(400).send("Invalid baseAmount");
        return;
      }

      if (typeof tipPercent !== "number" || tipPercent < 0) {
        res.status(400).send("Invalid tipPercent");
        return;
      }

      const config = await loadFeeConfig();

      const tipAmount = Math.round(baseAmount * tipPercent);
      const netAmount = baseAmount + tipAmount;

      const grossAmount = computeGrossAmount(netAmount, config);
      const paystackFee = grossAmount - netAmount;

      res.json({
        baseAmount,
        tipAmount,
        netAmount,
        paystackFee,
        grossAmount,
      });
    } catch (err) {
      logger.error("Fee calculation error", err);
      res.status(500).send("Internal error");
    }
  }
);
