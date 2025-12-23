// functions/src/lib/feeEngine.ts
import { db } from "./firebaseAdmin";

export interface FeeConfig {
  percentage: number; // e.g. 0.015
  flatFee: number; // e.g. 100
  cap: number; // e.g. 2000
  vatPercentage: number; // e.g. 0.075
  flatFeeWaiverThreshold: number; // e.g. 2500
}

const FEE_CONFIG_DOC_ID = process.env.FEE_CONFIG_DOC_ID || "fees";

let cachedConfig: FeeConfig | null = null;

export async function loadFeeConfig(): Promise<FeeConfig> {
  if (cachedConfig) return cachedConfig;

  const doc = await db.collection("configs").doc(FEE_CONFIG_DOC_ID).get();

  if (!doc.exists) {
    throw new Error(
      `Fee config doc '${FEE_CONFIG_DOC_ID}' not found in 'configs' collection`
    );
  }

  const data = doc.data()!;
  cachedConfig = {
    percentage: data.percentage,
    flatFee: data.flatFee,
    cap: data.cap,
    vatPercentage: data.vatPercentage,
    flatFeeWaiverThreshold: data.flatFeeWaiverThreshold,
  };

  return cachedConfig;
}

/**
 * Compute Paystack fee using:
 * - 1.5% of amount
 * - + ₦100 flat fee (waived under ₦2500)
 * - + VAT on fee
 * - capped at ₦2000
 */
export function computePaystackFee(amount: number, config: FeeConfig): number {
  // 1. Percentage fee
  let fee = amount * config.percentage;

  // 2. Flat fee (waived under threshold)
  if (amount >= config.flatFeeWaiverThreshold) {
    fee += config.flatFee;
  }

  // 3. VAT
  fee = fee * (1 + config.vatPercentage);

  // 4. Cap
  if (fee > config.cap) {
    fee = config.cap;
  }

  return Math.ceil(fee);
}

/**
 * Compute gross amount such that:
 * donor pays (netAmount + fee),
 * and fee follows Paystack rules.
 */
export function computeGrossAmount(
  netAmount: number,
  config: FeeConfig
): number {
  // Start with an estimate
  let gross = netAmount;

  while (true) {
    const fee = computePaystackFee(gross, config);
    const expectedGross = netAmount + fee;

    if (expectedGross === gross) {
      return gross;
    }

    gross = expectedGross;
  }
}
