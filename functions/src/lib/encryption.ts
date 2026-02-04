import { KeyManagementServiceClient } from "@google-cloud/kms";
import CryptoJS from "crypto-js";
import { defineSecret } from "firebase-functions/params";

const devKeySecret = defineSecret("DEV_ENCRYPTION_KEY");
const blindIndexSaltSecret = defineSecret("BLIND_INDEX_SALT");

const isProd = process.env.ENV_TYPE === "production";

// PII field types for field-specific encryption
export enum PIIFieldType {
  EMAIL = "email",
  PHONE = "phone",
  NAME = "name",
  AUTHORIZATION_CODE = "auth_code",
  BIRTHDAY = "birthday",
  SUBACCOUNT_CODE = "subaccount_code",
}

// Structure for encrypted PII fields
export interface EncryptedField {
  ciphertext: string;
  iv: string;
  version: number;
  keyId: string;
}

// Current encryption version - increment when rotating keys
const ENCRYPTION_VERSION = 1;

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

// ============================================
// PII ENCRYPTION UTILITIES
// ============================================

/**
 * Encrypt a PII field with versioning and IV for AES-256
 * Uses KMS in production, CryptoJS in development
 */
export async function encryptPII(
  plaintext: string,
  _fieldType: PIIFieldType
): Promise<EncryptedField> {
  const iv = CryptoJS.lib.WordArray.random(16).toString();

  if (!isProd) {
    const key = devKeySecret.value();
    const ciphertext = CryptoJS.AES.encrypt(plaintext, key, {
      iv: CryptoJS.enc.Hex.parse(iv),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }).toString();

    return {
      ciphertext,
      iv,
      version: ENCRYPTION_VERSION,
      keyId: "dev-key",
    };
  }

  const keyName = getKmsKeyName();
  const client = new KeyManagementServiceClient();

  const [result] = await client.encrypt({
    name: keyName,
    plaintext: Buffer.from(plaintext),
    plaintextCrc32c: { value: crc32c(Buffer.from(plaintext)) },
  });

  return {
    ciphertext: result.ciphertext!.toString("base64"),
    iv,
    version: ENCRYPTION_VERSION,
    keyId: keyName,
  };
}

/**
 * Decrypt a PII field
 */
export async function decryptPII(encrypted: EncryptedField): Promise<string> {
  if (!isProd) {
    const key = devKeySecret.value();
    const bytes = CryptoJS.AES.decrypt(encrypted.ciphertext, key, {
      iv: CryptoJS.enc.Hex.parse(encrypted.iv),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  const client = new KeyManagementServiceClient();

  const [result] = await client.decrypt({
    name: encrypted.keyId,
    ciphertext: Buffer.from(encrypted.ciphertext, "base64"),
  });

  return result.plaintext!.toString();
}

// ============================================
// OTP HASHING (PBKDF2-based)
// ============================================

const OTP_ITERATIONS = 10000;
const OTP_KEY_SIZE = 256 / 32; // 256 bits

/**
 * Hash an OTP for secure storage
 * Uses PBKDF2 with random salt
 */
export function hashOTP(otp: string): string {
  const salt = CryptoJS.lib.WordArray.random(16).toString();
  const hash = CryptoJS.PBKDF2(otp, salt, {
    keySize: OTP_KEY_SIZE,
    iterations: OTP_ITERATIONS,
  }).toString();

  // Return salt:hash format
  return `${salt}:${hash}`;
}

/**
 * Verify an OTP against its hash
 */
export function verifyOTP(otp: string, storedHash: string): boolean {
  const [salt, expectedHash] = storedHash.split(":");
  if (!salt || !expectedHash) {
    return false;
  }

  const computedHash = CryptoJS.PBKDF2(otp, salt, {
    keySize: OTP_KEY_SIZE,
    iterations: OTP_ITERATIONS,
  }).toString();

  // Constant-time comparison to prevent timing attacks
  return constantTimeCompare(computedHash, expectedHash);
}

// ============================================
// BLIND INDEX (for searchable encrypted fields)
// ============================================

/**
 * Create a blind index for a value
 * Used to enable searching on encrypted fields without decryption
 */
export function createBlindIndex(value: string): string {
  const salt = blindIndexSaltSecret.value();
  const normalizedValue = value.toLowerCase().trim();
  return CryptoJS.HmacSHA256(normalizedValue, salt).toString();
}

// ============================================
// DETERMINISTIC ENCRYPTION (for exact-match lookups)
// ============================================

/**
 * Encrypt a value deterministically
 * Same plaintext always produces same ciphertext (for exact-match queries)
 * WARNING: Less secure than randomized encryption - use only where necessary
 */
export function encryptDeterministic(plaintext: string): string {
  const key = devKeySecret.value();
  const normalizedValue = plaintext.toLowerCase().trim();
  // Use HMAC as deterministic encryption (one-way, but consistent)
  return CryptoJS.HmacSHA256(normalizedValue, key).toString();
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Simple CRC32C implementation for KMS integrity verification
 */
function crc32c(data: Buffer): number {
  const CRC32C_TABLE = new Uint32Array(256);
  const POLYNOMIAL = 0x82f63b78;

  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ POLYNOMIAL : crc >>> 1;
    }
    CRC32C_TABLE[i] = crc >>> 0;
  }

  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32C_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
