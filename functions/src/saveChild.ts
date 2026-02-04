// functions/src/saveChild.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { encryptPII, PIIFieldType } from "./lib/encryption";
import { defineSecret } from "firebase-functions/params";
import { FieldValue } from "firebase-admin/firestore";

const devEncryptionKey = defineSecret("DEV_ENCRYPTION_KEY");
const blindIndexSalt = defineSecret("BLIND_INDEX_SALT");

interface SaveChildRequest {
  id?: string; // If provided, update; otherwise create
  name: string;
  gender: string;
  birthday: string;
  story: string;
  photoUrl: string;
  hobbies?: string[];
}

/**
 * Create or update a child with encrypted PII fields (name, birthday)
 * Only orphanage admins can save children for their orphanage
 */
export const saveChild = onRequest(
  { region: "europe-west1", secrets: [devEncryptionKey, blindIndexSalt] },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      // Verify the user is an orphanage admin
      let decoded;
      try {
        decoded = await verifyAuth(req, {
          requiredRoles: ["orphanageAdmin"],
        });
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const orphanageId = decoded.orphanageId as string;
      if (!orphanageId) {
        res.status(403).send("No orphanage associated with this account");
        return;
      }

      const {
        id,
        name,
        gender,
        birthday,
        story,
        photoUrl,
        hobbies,
      }: SaveChildRequest = req.body;

      // Validate required fields
      if (!name || !gender || !birthday || !story || !photoUrl) {
        res.status(400).send("Missing required fields");
        return;
      }

      logger.info(`saveChild triggered by orphanage ${orphanageId}, childId: ${id || "new"}`);

      // Encrypt PII fields
      const [nameEncrypted, birthdayEncrypted] = await Promise.all([
        encryptPII(name, PIIFieldType.NAME),
        encryptPII(birthday, PIIFieldType.BIRTHDAY),
      ]);

      // Build child data
      const childData: Record<string, any> = {
        // Encrypted fields
        name_encrypted: nameEncrypted,
        birthday_encrypted: birthdayEncrypted,
        // Clear plaintext fields (migration cleanup)
        name: null,
        birthday: null,
        // Non-PII fields
        gender,
        story,
        photoUrl,
        hobbies: hobbies || [],
        orphanageId,
        updatedAt: FieldValue.serverTimestamp(),
      };

      let childId: string;

      if (id) {
        // Update existing child
        const childRef = db.collection("children").doc(id);
        const childDoc = await childRef.get();

        if (!childDoc.exists) {
          res.status(404).send("Child not found");
          return;
        }

        // Verify the child belongs to this orphanage
        if (childDoc.data()?.orphanageId !== orphanageId) {
          res.status(403).send("Not authorized to update this child");
          return;
        }

        await childRef.update(childData);
        childId = id;
        logger.info(`Child ${id} updated by orphanage ${orphanageId}`);
      } else {
        // Create new child
        childData.createdAt = FieldValue.serverTimestamp();
        const docRef = await db.collection("children").add(childData);
        childId = docRef.id;
        logger.info(`Child ${childId} created for orphanage ${orphanageId}`);
      }

      res.json({ success: true, childId });
    } catch (error) {
      logger.error("saveChild error", error);
      res.status(500).send("Internal error");
    }
  }
);
