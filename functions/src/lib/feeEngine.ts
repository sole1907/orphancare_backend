// functions/src/lib/feeEngine.ts
import { db } from "./firebaseAdmin";

export interface FeeConfig {
  percentage: number; // e.g. 0.015
  flatFee: number; // e.g. 100
  cap: number; // e.g. 2000
}

// Optional: allow overriding doc ID via env
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
  };

  return cachedConfig;
}

export function computePaystackFee(
  netAmount: number,
  config: FeeConfig
): number {
  let fee = Math.ceil(netAmount * config.percentage + config.flatFee);
  if (fee > config.cap) fee = config.cap;
  return fee;
}

/**
 * Compute gross amount such that:
 * donor pays (netAmount + fee), not netAmount,
 * and fee follows Paystack rules.
 */
export function computeGrossAmount(
  netAmount: number,
  config: FeeConfig
): number {
  // First approximation: solve gross = (net + flat) / (1 - percentage)
  let gross = Math.ceil((netAmount + config.flatFee) / (1 - config.percentage));

  // Recompute fee on that gross to ensure cap is respected
  const feeOnGross = computePaystackFee(gross, config);

  if (feeOnGross > config.cap) {
    // When capped, donor just pays net + cap
    return netAmount + config.cap;
  }

  return gross;
}
