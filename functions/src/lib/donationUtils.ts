import { db } from "./firebaseAdmin";
import * as logger from "firebase-functions/logger";

export interface DonationAmounts {
  tipAmount: number;
  netAmount: number;
  grossAmount: number;
  paystackFee: number;
  orphanageAmount: number;
  platformAmount: number;
}

export function computeDonationAmounts(
  baseAmount: number,
  tipPercent: number,
  config: { feePercent: number; flatFee: number }
): DonationAmounts {
  const tipAmount = Math.round(baseAmount * tipPercent);
  const netAmount = baseAmount + tipAmount;

  // You already have computeGrossAmount, but we keep this wrapper
  const grossAmount =
    netAmount + config.flatFee + netAmount * config.feePercent;
  const paystackFee = grossAmount - netAmount;

  const orphanageAmount = Math.round(baseAmount * 100);
  const platformAmount = Math.round(tipAmount * 100);

  return {
    tipAmount,
    netAmount,
    grossAmount,
    paystackFee,
    orphanageAmount,
    platformAmount,
  };
}

interface LogDonationIntentParams {
  donorUid: string;
  donorEmail: string;
  childId: string;
  orphanageId: string;
  grossAmount: number;
  baseAmount: number;
  tipPercent: number;
  tipAmount: number;
  netAmount: number;
  paystackFee: number;
  orphanageAmount: number;
  platformAmount: number;
  recurring: boolean;
  interval: string | null;
  paystackRef: string;
}

export async function logDonationIntent(
  params: LogDonationIntentParams
): Promise<FirebaseFirestore.DocumentReference> {
  const {
    donorUid,
    donorEmail,
    childId,
    orphanageId,
    grossAmount,
    baseAmount,
    tipPercent,
    tipAmount,
    netAmount,
    paystackFee,
    orphanageAmount,
    platformAmount,
    recurring,
    interval,
    paystackRef,
  } = params;

  logger.info(
    `Logging donation intent: donorUid=${donorUid}, childId=${childId}, orphanageId=${orphanageId}, grossAmount=${grossAmount}, recurring=${recurring}, interval=${interval}, ref=${paystackRef}`
  );

  const docRef = await db.collection("donations").add({
    donorUid,
    donorEmail,
    childId,
    orphanageId,
    amount: grossAmount,
    baseAmount,
    tipPercent,
    tipAmount,
    netAmount,
    paystackFee,
    orphanageAmount,
    platformAmount,
    recurring,
    interval,
    paystackRef,
    createdAt: new Date(),
    status: "pending",
  });

  logger.info(`Donation intent logged with id=${docRef.id}`);
  return docRef;
}

interface CreateRecurringPlanIntentParams {
  donorUid: string;
  childId: string;
  orphanageId: string;
  baseAmount: number;
  tipPercent: number;
  tipAmount: number;
  netAmount: number;
  grossAmount: number;
  paystackFeeEstimate: number;
  orphanageAmount: number;
  platformAmount: number;
  interval: string;
  donorEmail: string;
  preferredPaymentDay?: number;
}

/**
 * Marks existing pending donations as "abandoned" for the same donor/child/orphanage.
 * This prevents duplicate entries if the frontend sends multiple initiation requests.
 */
export async function abandonExistingPendingDonations(
  donorUid: string,
  childId: string,
  orphanageId: string,
  recurring: boolean,
  baseAmount: number
): Promise<number> {
  logger.info(
    `Checking for existing pending donations: donorUid=${donorUid}, childId=${childId}, orphanageId=${orphanageId}, recurring=${recurring}, baseAmount=${baseAmount}`
  );

  const pendingDonations = await db
    .collection("donations")
    .where("donorUid", "==", donorUid)
    .where("childId", "==", childId)
    .where("orphanageId", "==", orphanageId)
    .where("recurring", "==", recurring)
    .where("baseAmount", "==", baseAmount)
    .where("status", "==", "pending")
    .get();

  if (pendingDonations.empty) {
    logger.info("No existing pending donations found");
    return 0;
  }

  const batch = db.batch();
  pendingDonations.docs.forEach((doc) => {
    batch.update(doc.ref, {
      status: "abandoned",
      abandonedAt: new Date(),
      abandonReason: "superseded_by_new_initiation",
    });
  });

  await batch.commit();
  logger.info(
    `Marked ${pendingDonations.size} existing pending donation(s) as abandoned`
  );

  return pendingDonations.size;
}

export async function createRecurringPlanIntent(
  params: CreateRecurringPlanIntentParams
): Promise<string> {
  const {
    donorUid,
    childId,
    orphanageId,
    baseAmount,
    tipPercent,
    tipAmount,
    netAmount,
    grossAmount,
    paystackFeeEstimate,
    orphanageAmount,
    platformAmount,
    interval,
    donorEmail,
    preferredPaymentDay,
  } = params;

  const planCode = `RC_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  logger.info(
    `Creating recurring plan intent: planCode=${planCode}, donorUid=${donorUid}, childId=${childId}, orphanageId=${orphanageId}, interval=${interval}, preferredPaymentDay=${preferredPaymentDay}`
  );

  await db.collection("recurringPlans").doc(planCode).set({
    donorUid,
    childId,
    orphanageId,
    baseAmount,
    tipPercent,
    tipAmount,
    netAmount,
    grossAmount,
    paystackFeeEstimate,
    orphanageAmount,
    platformAmount,
    interval,
    planCode,
    createdAt: new Date(),
    status: "pending",
    authorizationCode: null,
    customerEmail: donorEmail,
    preferredPaymentDay: preferredPaymentDay ?? null,
  });

  logger.info(`Recurring plan intent stored with planCode=${planCode}`);
  return planCode;
}
