import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";

interface DonationHistoryItem {
  id: string;
  amount: number;
  baseAmount: number;
  tipAmount: number;
  childId: string;
  childName: string | null;
  childPhoto: string | null;
  orphanageId: string;
  orphanageName: string | null;
  status: string;
  recurring: boolean;
  interval: string | null;
  createdAt: Date;
}

export const getDonationHistory = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      // Auth check - must be a donor
      let donorUid: string;
      try {
        const decoded = await verifyAuth(req, { requiredRoles: ["donor"] });
        donorUid = decoded.uid;
        logger.info(`getDonationHistory triggered by ${donorUid}`);
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const { limit = 20, lastDocId, status } = req.body;

      // Build query
      let query = db
        .collection("donations")
        .where("donorUid", "==", donorUid)
        .orderBy("createdAt", "desc");

      // Optional status filter
      if (status && ["success", "pending", "failed"].includes(status)) {
        query = query.where("status", "==", status);
      }

      // Cursor-based pagination
      if (lastDocId) {
        const lastDoc = await db.collection("donations").doc(lastDocId).get();
        if (lastDoc.exists) {
          query = query.startAfter(lastDoc);
        }
      }

      // Fetch one extra to check if there are more
      const snapshot = await query.limit(limit + 1).get();

      const hasMore = snapshot.docs.length > limit;
      const docs = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;

      // Collect unique childIds and orphanageIds for batch lookup
      const childIds = new Set<string>();
      const orphanageIds = new Set<string>();

      docs.forEach((doc) => {
        const data = doc.data();
        if (data.childId) childIds.add(data.childId);
        if (data.orphanageId) orphanageIds.add(data.orphanageId);
      });

      // Batch fetch children and orphanages
      const childMap = new Map<string, { name: string; photo: string | null }>();
      const orphanageMap = new Map<string, { name: string }>();

      if (childIds.size > 0) {
        const childIdArray = Array.from(childIds);
        // Firestore getAll supports up to 100 docs at a time
        for (let i = 0; i < childIdArray.length; i += 100) {
          const batch = childIdArray.slice(i, i + 100);
          const refs = batch.map((id) => db.collection("children").doc(id));
          const childDocs = await db.getAll(...refs);
          childDocs.forEach((doc) => {
            if (doc.exists) {
              const data = doc.data();
              childMap.set(doc.id, {
                name: data?.name || "Unknown Child",
                photo: data?.photo || null,
              });
            }
          });
        }
      }

      if (orphanageIds.size > 0) {
        const orphanageIdArray = Array.from(orphanageIds);
        for (let i = 0; i < orphanageIdArray.length; i += 100) {
          const batch = orphanageIdArray.slice(i, i + 100);
          const refs = batch.map((id) => db.collection("orphanages").doc(id));
          const orphanageDocs = await db.getAll(...refs);
          orphanageDocs.forEach((doc) => {
            if (doc.exists) {
              const data = doc.data();
              orphanageMap.set(doc.id, {
                name: data?.name || "Unknown Orphanage",
              });
            }
          });
        }
      }

      // Build response
      const donations: DonationHistoryItem[] = docs.map((doc) => {
        const data = doc.data();
        const child = childMap.get(data.childId);
        const orphanage = orphanageMap.get(data.orphanageId);

        return {
          id: doc.id,
          amount: data.amount || data.netAmount || 0,
          baseAmount: data.baseAmount || 0,
          tipAmount: data.tipAmount || 0,
          childId: data.childId,
          childName: child?.name || null,
          childPhoto: child?.photo || null,
          orphanageId: data.orphanageId,
          orphanageName: orphanage?.name || null,
          status: data.status,
          recurring: data.recurring || false,
          interval: data.interval || null,
          createdAt: data.createdAt?.toDate?.() || data.createdAt,
        };
      });

      const newLastDocId = docs.length > 0 ? docs[docs.length - 1].id : null;

      logger.info(
        `Returning ${donations.length} donations, hasMore: ${hasMore}`
      );

      res.json({
        data: {
          donations,
          hasMore,
          lastDocId: newLastDocId,
        },
      });
    } catch (error) {
      logger.error("getDonationHistory error", error);
      res.status(500).send("Internal error");
    }
  }
);
