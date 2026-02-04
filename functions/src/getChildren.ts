// functions/src/getChildren.ts
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

interface ChildResponse {
  id: string;
  name: string;
  gender: string;
  birthday: string;
  story: string;
  photoUrl: string;
  hobbies: string[];
  orphanageId: string;
  orphanageName: string;
  createdAt: string | null;
}

interface GetChildrenResponse {
  children: ChildResponse[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Extract child PII fields, handling both encrypted and plaintext formats
 */
async function extractChildPII(
  childData: any
): Promise<{ name: string; birthday: string }> {
  let name = "";
  let birthday = "";

  // Try encrypted fields first, fall back to plaintext
  if (childData.name_encrypted) {
    try {
      name = await decryptPII(childData.name_encrypted as EncryptedField);
    } catch {
      name = childData.name ?? "";
    }
  } else {
    name = childData.name ?? "";
  }

  if (childData.birthday_encrypted) {
    try {
      birthday = await decryptPII(childData.birthday_encrypted as EncryptedField);
    } catch {
      birthday = childData.birthday ?? "";
    }
  } else {
    birthday = childData.birthday ?? "";
  }

  return { name, birthday };
}

/**
 * Get paginated list of children with decrypted PII fields
 * - Donors: see children from active, approved orphanages only
 * - Orphanage Admins: see children from their orphanage only
 * - Super Admins: see all children
 */
export const getChildren = onRequest(
  { region: "europe-west1", secrets: [devEncryptionKey, blindIndexSalt] },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      // Verify the user is authenticated
      let decoded;
      try {
        decoded = await verifyAuth(req);
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const isSuperAdmin = !!decoded.superAdmin;
      const isOrphanageAdmin = !!decoded.orphanageAdmin;
      const orphanageId = decoded.orphanageId as string | undefined;

      logger.info(`getChildren triggered by ${decoded.uid}, superAdmin=${isSuperAdmin}, orphanageAdmin=${isOrphanageAdmin}`);

      const { cursor, pageSize = 10 } = req.body;

      // Build orphanage map for enrichment
      const orphanageMap: Record<string, string> = {};
      let allowedOrphanageIds: string[] | null = null; // null means all allowed

      if (isSuperAdmin) {
        // Super admin sees all children - fetch all orphanages for name mapping
        const allOrphanagesSnapshot = await db.collection("orphanages").get();
        allOrphanagesSnapshot.docs.forEach((doc) => {
          orphanageMap[doc.id] = doc.data().name || "Unknown Orphanage";
        });
      } else if (isOrphanageAdmin && orphanageId) {
        // Orphanage admin sees only their children
        allowedOrphanageIds = [orphanageId];
        const orphanageDoc = await db.collection("orphanages").doc(orphanageId).get();
        if (orphanageDoc.exists) {
          orphanageMap[orphanageId] = orphanageDoc.data()?.name || "Unknown Orphanage";
        }
      } else {
        // Donor sees children from active + approved orphanages only
        const orphanagesSnapshot = await db
          .collection("orphanages")
          .where("status", "==", "Active")
          .where("accountVerificationStatus", "==", "approved")
          .get();

        if (orphanagesSnapshot.empty) {
          res.json({
            data: {
              children: [],
              nextCursor: null,
              hasMore: false,
            } as GetChildrenResponse,
          });
          return;
        }

        allowedOrphanageIds = [];
        orphanagesSnapshot.docs.forEach((doc) => {
          allowedOrphanageIds!.push(doc.id);
          orphanageMap[doc.id] = doc.data().name || "Unknown Orphanage";
        });
      }

      // Query children
      const allChildren: ChildResponse[] = [];

      if (allowedOrphanageIds === null) {
        // Super admin - query all children
        let childrenQuery = db
          .collection("children")
          .orderBy("createdAt", "desc")
          .limit(pageSize + 1);

        if (cursor) {
          const cursorDoc = await db.collection("children").doc(cursor).get();
          if (cursorDoc.exists) {
            childrenQuery = childrenQuery.startAfter(cursorDoc);
          }
        }

        const childrenSnapshot = await childrenQuery.get();

        for (const childDoc of childrenSnapshot.docs) {
          const childData = childDoc.data();
          const { name, birthday } = await extractChildPII(childData);

          allChildren.push({
            id: childDoc.id,
            name,
            birthday,
            gender: childData.gender ?? "",
            story: childData.story ?? "",
            photoUrl: childData.photoUrl ?? "",
            hobbies: childData.hobbies ?? [],
            orphanageId: childData.orphanageId,
            orphanageName: orphanageMap[childData.orphanageId] || "Unknown",
            createdAt: childData.createdAt?.toDate?.()?.toISOString?.() || null,
          });
        }
      } else if (allowedOrphanageIds.length > 0) {
        // Batch query for allowed orphanages (Firestore 'in' limited to 30)
        const batchSize = 30;

        for (let i = 0; i < allowedOrphanageIds.length; i += batchSize) {
          const batchIds = allowedOrphanageIds.slice(i, i + batchSize);

          let childrenQuery = db
            .collection("children")
            .where("orphanageId", "in", batchIds)
            .orderBy("createdAt", "desc")
            .limit(pageSize + 1);

          if (cursor) {
            const cursorDoc = await db.collection("children").doc(cursor).get();
            if (cursorDoc.exists) {
              childrenQuery = childrenQuery.startAfter(cursorDoc);
            }
          }

          const childrenSnapshot = await childrenQuery.get();

          for (const childDoc of childrenSnapshot.docs) {
            const childData = childDoc.data();
            const { name, birthday } = await extractChildPII(childData);

            allChildren.push({
              id: childDoc.id,
              name,
              birthday,
              gender: childData.gender ?? "",
              story: childData.story ?? "",
              photoUrl: childData.photoUrl ?? "",
              hobbies: childData.hobbies ?? [],
              orphanageId: childData.orphanageId,
              orphanageName: orphanageMap[childData.orphanageId] || "Unknown",
              createdAt: childData.createdAt?.toDate?.()?.toISOString?.() || null,
            });
          }
        }

        // Sort all results by createdAt descending (needed when batching)
        allChildren.sort((a, b) => {
          if (!a.createdAt) return 1;
          if (!b.createdAt) return -1;
          return b.createdAt.localeCompare(a.createdAt);
        });
      }

      // Apply pagination
      const hasMore = allChildren.length > pageSize;
      const paginatedChildren = allChildren.slice(0, pageSize);
      const nextCursor = hasMore
        ? paginatedChildren[paginatedChildren.length - 1]?.id
        : null;

      const response: GetChildrenResponse = {
        children: paginatedChildren,
        nextCursor,
        hasMore,
      };

      logger.info(`Returning ${paginatedChildren.length} children`);
      res.json({ data: response });
    } catch (error) {
      logger.error("getChildren error", error);
      res.status(500).send("Internal error");
    }
  }
);
