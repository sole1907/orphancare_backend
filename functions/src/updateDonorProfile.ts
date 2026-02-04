// functions/src/updateDonorProfile.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import {
  encryptPII,
  createBlindIndex,
  encryptDeterministic,
  PIIFieldType,
} from "./lib/encryption";
import { defineSecret } from "firebase-functions/params";

const devEncryptionKey = defineSecret("DEV_ENCRYPTION_KEY");
const blindIndexSalt = defineSecret("BLIND_INDEX_SALT");

interface UpdateProfileRequest {
  name?: string;
  phone?: string;
  country?: string;
  donorBirthdayMonth?: string | null;
  donorBirthdayDay?: number | null;
  donorHobbies?: string[];
  photoUrl?: string | null;
  pushNotificationsEnabled?: boolean;
}

/**
 * Update the authenticated donor's profile with encrypted PII fields
 */
export const updateDonorProfile = onRequest(
  { region: "europe-west1", secrets: [devEncryptionKey, blindIndexSalt] },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      // Verify the donor is authenticated
      let decoded;
      try {
        decoded = await verifyAuth(req);
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const donorUid = decoded.uid;
      logger.info(`updateDonorProfile triggered by ${donorUid}`);

      const {
        name,
        phone,
        country,
        donorBirthdayMonth,
        donorBirthdayDay,
        donorHobbies,
        photoUrl,
        pushNotificationsEnabled,
      }: UpdateProfileRequest = req.body;

      // Build update object
      const updateData: Record<string, any> = {};

      // Encrypt PII fields if provided
      if (name !== undefined) {
        const nameEncrypted = await encryptPII(name, PIIFieldType.NAME);
        updateData.name_encrypted = nameEncrypted;
        // Clear plaintext field if it exists (migration cleanup)
        updateData.name = null;
      }

      if (phone !== undefined) {
        const phoneEncrypted = await encryptPII(phone, PIIFieldType.PHONE);
        updateData.phone_encrypted = phoneEncrypted;
        updateData.phone_deterministic = encryptDeterministic(phone);
        // Clear plaintext field if it exists (migration cleanup)
        updateData.phone = null;
      }

      // Non-PII fields - update directly
      if (country !== undefined) {
        updateData.country = country;
      }

      if (donorBirthdayMonth !== undefined) {
        updateData.donorBirthdayMonth = donorBirthdayMonth;
      }

      if (donorBirthdayDay !== undefined) {
        updateData.donorBirthdayDay = donorBirthdayDay;
      }

      if (donorHobbies !== undefined) {
        updateData.donorHobbies = donorHobbies;
      }

      if (photoUrl !== undefined) {
        updateData.photoUrl = photoUrl;
      }

      if (pushNotificationsEnabled !== undefined) {
        updateData.pushNotificationsEnabled = pushNotificationsEnabled;
      }

      // Only update if there's something to update
      if (Object.keys(updateData).length === 0) {
        res.status(400).send("No fields to update");
        return;
      }

      // Update Firestore
      await db.collection("donors").doc(donorUid).update(updateData);

      logger.info(`Profile updated for donor ${donorUid}`);
      res.json({ success: true });
    } catch (error) {
      logger.error("updateDonorProfile error", error);
      res.status(500).send("Internal error");
    }
  }
);
