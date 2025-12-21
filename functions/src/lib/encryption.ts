import { KeyManagementServiceClient } from "@google-cloud/kms";
import CryptoJS from "crypto-js";
import * as functions from "firebase-functions";
import { defineSecret } from "firebase-functions/params";

const devKeySecret = defineSecret("DEV_ENCRYPTION_KEY");

const isProd = process.env.ENV_TYPE === "production";

function getKmsKeyName() {
  const projectId = process.env.GCP_PROJECT || process.env.GCLOUD_PROJECT;

  if (!projectId) {
    throw new Error("GCP_PROJECT is not defined at runtime");
  }

  const client = new KeyManagementServiceClient();

  return client.cryptoKeyPath(
    projectId,
    "global",
    "orphancare-keys",
    "bank-account-key"
  );
}

export async function encrypt(text: string): Promise<string> {
  if (!isProd) {
    const key = devKeySecret.value();
    return CryptoJS.AES.encrypt(text, key).toString();
  }

  const keyName = getKmsKeyName();
  const client = new KeyManagementServiceClient();

  const [result] = await client.encrypt({
    name: keyName,
    plaintext: Buffer.from(text),
  });

  return result.ciphertext!.toString("base64");
}

export async function decrypt(ciphertext: string): Promise<string> {
  if (!isProd) {
    const key = devKeySecret.value();
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  const keyName = getKmsKeyName();
  const client = new KeyManagementServiceClient();

  const [result] = await client.decrypt({
    name: keyName,
    ciphertext: Buffer.from(ciphertext, "base64"),
  });

  return result.plaintext!.toString();
}
