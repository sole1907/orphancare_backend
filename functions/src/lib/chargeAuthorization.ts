// functions/src/lib/chargeAuthorization.ts
import fetch from "node-fetch";
import * as logger from "firebase-functions/logger";
import { decryptPII, EncryptedField } from "./encryption";

interface ChargePlanParams {
  planDocRef: FirebaseFirestore.DocumentReference;
  plan: any;
  PAYSTACK_URI: string;
  secret: string;
  subaccountCode: string;
}

export async function chargeAuthorizationForPlan({
  planDocRef,
  plan,
  PAYSTACK_URI,
  secret,
  subaccountCode,
}: ChargePlanParams) {
  const { authorizationCode_encrypted, customerEmail, grossAmount, interval, planCode } =
    plan;

  if (!authorizationCode_encrypted) {
    logger.error(`Plan ${planCode} has no authorizationCode_encrypted`);
    return;
  }

  // Decrypt the authorization code
  const authorizationCode = await decryptPII(
    authorizationCode_encrypted as EncryptedField
  );

  const body = {
    email: customerEmail,
    amount: Math.round(grossAmount * 100),
    authorization_code: authorizationCode,
    subaccount: subaccountCode,
    transaction_charge: plan.platformAmount,
    metadata: {
      planCode,
      recurring: true,
      orphanageId: plan.orphanageId,
      childId: plan.childId,
      donorUid: plan.donorUid,
    },
  };

  logger.info(
    `Charging authorization for planCode=${planCode}, email=${customerEmail}, amount=${body.amount}`
  );

  const response = await fetch(
    `${PAYSTACK_URI}/transaction/charge_authorization`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const raw = await response.text();
  logger.info(
    `charge_authorization raw response: status=${response.status}, body=${raw}`
  );

  // We rely on charge.success webhook as source of truth.
  // Here we only update nextChargeAt / retryCount.

  const now = new Date();
  const nextChargeAt = computeNextChargeAt(now, interval);

  await planDocRef.update({
    lastChargeAt: now,
    nextChargeAt,
    retryCount: 0,
  });
}

export function computeNextChargeAt(from: Date, interval: string): Date {
  const d = new Date(from);

  switch (interval.toLowerCase()) {
    case "daily":
      d.setDate(d.getDate() + 1);
      break;
    case "monthly":
      d.setMonth(d.getMonth() + 1);
      break;
    case "quarterly":
      d.setMonth(d.getMonth() + 3);
      break;
    case "yearly":
      d.setFullYear(d.getFullYear() + 1);
      break;
    default:
      throw new Error(`Unsupported interval: ${interval}`);
  }

  // Normalize to 00:00:00 UTC to ensure it's always before 12:00 noon Africa/Lagos
  d.setUTCHours(0, 0, 0, 0);

  return d;
}
