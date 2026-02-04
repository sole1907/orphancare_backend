// functions/src/getDonorProfile.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { decryptPII, EncryptedField } from "./lib/encryption";
import { defineSecret } from "firebase-functions/params";

const devEncryptionKey = defineSecret("DEV_ENCRYPTION_KEY");
const blindIndexSalt = defineSecret("BLIND_INDEX_SALT");

interface DonorProfileResponse {
  uid: string;
  name: string;
  email: string;
  phone: string;
  country: string;
  status: string;
  donorBirthdayMonth: string | null;
  donorBirthdayDay: number | null;
  donorHobbies: string[];
  photoUrl: string | null;
  pushNotificationsEnabled: boolean;
}

/**
 * Get the authenticated donor's profile with decrypted PII fields
 */
export const getDonorProfile = onRequest(
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
      logger.info(`getDonorProfile triggered by ${donorUid}`);

      // Fetch donor document
      const donorDoc = await db.collection("donors").doc(donorUid).get();
      if (!donorDoc.exists) {
        res.status(404).send("Donor not found");
        return;
      }

      const donorData = donorDoc.data()!;

      // Decrypt PII fields with fallback to plaintext
      let name = "";
      let email = "";
      let phone = "";

      if (donorData.name_encrypted) {
        try {
          name = await decryptPII(donorData.name_encrypted as EncryptedField);
        } catch (err) {
          logger.warn(`Failed to decrypt name for ${donorUid}`, err);
          name = donorData.name ?? "";
        }
      } else {
        name = donorData.name ?? "";
      }

      if (donorData.email_encrypted) {
        try {
          email = await decryptPII(donorData.email_encrypted as EncryptedField);
        } catch (err) {
          logger.warn(`Failed to decrypt email for ${donorUid}`, err);
          email = donorData.email ?? "";
        }
      } else {
        email = donorData.email ?? "";
      }

      if (donorData.phone_encrypted) {
        try {
          phone = await decryptPII(donorData.phone_encrypted as EncryptedField);
        } catch (err) {
          logger.warn(`Failed to decrypt phone for ${donorUid}`, err);
          phone = donorData.phone ?? "";
        }
      } else {
        phone = donorData.phone ?? "";
      }

      const response: DonorProfileResponse = {
        uid: donorUid,
        name,
        email,
        phone,
        country: donorData.country ?? "",
        status: donorData.status ?? "inactive",
        donorBirthdayMonth: donorData.donorBirthdayMonth ?? null,
        donorBirthdayDay: donorData.donorBirthdayDay ?? null,
        donorHobbies: donorData.donorHobbies ?? [],
        photoUrl: donorData.photoUrl ?? null,
        pushNotificationsEnabled: donorData.pushNotificationsEnabled ?? true,
      };

      logger.info(`Returning profile for donor ${donorUid}`);
      res.json({ data: response });
    } catch (error) {
      logger.error("getDonorProfile error", error);
      res.status(500).send("Internal error");
    }
  }
);
