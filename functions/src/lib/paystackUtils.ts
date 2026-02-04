import fetch from "node-fetch";
import * as logger from "firebase-functions/logger";
import { decryptPII, EncryptedField } from "./encryption";

interface InitTransactionParams {
  email: string;
  amount: number; // in kobo
  metadata: Record<string, any>;
  callbackUrl: string;
  paystackSecretValue: string;
  PAYSTACK_URI: string;
  subaccount?: string;
  transactionCharge?: number;
}

export async function initPaystackTransaction(
  params: InitTransactionParams
): Promise<{ authorization_url: string; reference: string }> {
  const {
    email,
    amount,
    metadata,
    callbackUrl,
    paystackSecretValue,
    PAYSTACK_URI,
    subaccount,
    transactionCharge,
  } = params;

  const body: any = {
    email,
    amount,
    metadata,
    callback_url: callbackUrl,
  };

  if (subaccount) {
    body.subaccount = subaccount;
    body.bearer = "subaccount";
  }

  if (transactionCharge !== undefined) {
    body.transaction_charge = transactionCharge;
  }

  logger.info(
    `Initializing Paystack transaction: email=${email}, amount=${amount}, subaccount=${subaccount}, transactionCharge=${transactionCharge}`
  );

  const response = await fetch(`${PAYSTACK_URI}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paystackSecretValue}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  logger.info(
    `Paystack init raw response: status=${response.status}, body=${raw}`
  );

  let data: any;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    logger.error("Failed to parse Paystack init JSON", err);
    throw new Error("Invalid Paystack init response");
  }

  if (!data.status) {
    logger.error(
      `Paystack init failed: message=${data.message}, errors=${JSON.stringify(
        data.errors || {},
        null,
        2
      )}`
    );
    throw new Error(data.message || "Paystack init failed");
  }

  return {
    authorization_url: data.data.authorization_url,
    reference: data.data.reference,
  };
}

/**
 * Get subaccount code from orphanage data, supporting both encrypted and legacy plain text fields
 */
export async function getSubaccountCode(
  orphanageData: any
): Promise<string | null> {
  // Prefer encrypted field
  if (orphanageData.subaccountCode_encrypted) {
    return decryptPII(orphanageData.subaccountCode_encrypted as EncryptedField);
  }
  // Fall back to legacy plain text (migration period)
  if (orphanageData.subaccountCode) {
    return orphanageData.subaccountCode;
  }
  return null;
}
