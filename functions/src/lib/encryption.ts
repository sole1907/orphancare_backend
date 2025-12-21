import { KeyManagementServiceClient } from "@google-cloud/kms";
import CryptoJS from "crypto-js";
import { defineSecret } from "firebase-functions/params";

const devKeySecret = defineSecret("DEV_ENCRYPTION_KEY");

const client = new KeyManagementServiceClient();

const keyName = client.cryptoKeyPath(
  process.env.GCP_PROJECT!,
  "global",
  "orphancare-keys",
  "bank-account-key"
);

const isProd = process.env.NODE_ENV === "production";

export async function encrypt(text: string): Promise<string> {
  if (!isProd) {
    // DEV MODE — AES encryption
    const key = devKeySecret.value();
    return CryptoJS.AES.encrypt(text, key).toString();
  }

  // PROD MODE — KMS encryption
  const [result] = await client.encrypt({
    name: keyName,
    plaintext: Buffer.from(text),
  });

  return result.ciphertext!.toString("base64");
}

export async function decrypt(ciphertext: string): Promise<string> {
  if (!isProd) {
    // DEV MODE — AES decryption
    const key = devKeySecret.value();
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  // PROD MODE — KMS decryption
  const [result] = await client.decrypt({
    name: keyName,
    ciphertext: Buffer.from(ciphertext, "base64"),
  });

  return result.plaintext!.toString();
}
