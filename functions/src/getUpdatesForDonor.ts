import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { UpdateData } from "./types/update";

export const getUpdatesForDonor = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      // Auth check - must be a donor
      let donorUid: string;
      try {
        const decoded = await verifyAuth(req, { requiredRoles: ["donor"] });
        donorUid = decoded.uid;
        logger.info(`getUpdatesForDonor triggered by ${donorUid}`);
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const { limit = 20, lastUpdateId } = req.body;

      // 1. Get followed childIds from donor_follows subcollection
      const followedSnapshot = await db
        .collection("donor_follows")
        .doc(donorUid)
        .collection("children")
        .get();

      const followedChildIds = followedSnapshot.docs.map((doc) => doc.id);
      logger.info(`Followed children: ${followedChildIds.length}`);

      // 2. Get childIds and orphanageIds from donations in last 12 months
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

      const donationsSnapshot = await db
        .collection("donations")
        .where("donorUid", "==", donorUid)
        .where("createdAt", ">=", twelveMonthsAgo)
        .where("status", "==", "success")
        .get();

      const donatedChildIds = new Set<string>();
      const donatedOrphanageIds = new Set<string>();

      donationsSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        if (data.childId) donatedChildIds.add(data.childId);
        if (data.orphanageId) donatedOrphanageIds.add(data.orphanageId);
      });

      logger.info(
        `Donated to ${donatedChildIds.size} children, ${donatedOrphanageIds.size} orphanages`
      );

      // 3. Combine unique childIds (followed + donated)
      const relevantChildIds = new Set([
        ...followedChildIds,
        ...donatedChildIds,
      ]);
      const relevantOrphanageIds = Array.from(donatedOrphanageIds);

      // 4. If no relationships, return empty
      if (relevantChildIds.size === 0 && relevantOrphanageIds.length === 0) {
        res.json({ updates: [], hasMore: false, lastUpdateId: null });
        return;
      }

      // 5. Query updates - we need to do this in parts due to Firestore limitations
      // Firestore "in" queries support max 30 items, so we'll fetch and merge
      const updates: (UpdateData & { id: string })[] = [];

      // 5a. Get child-specific updates (childId in relevantChildIds)
      const childIdArray = Array.from(relevantChildIds);
      if (childIdArray.length > 0) {
        // Process in batches of 30 (Firestore limit for "in" queries)
        for (let i = 0; i < childIdArray.length; i += 30) {
          const batch = childIdArray.slice(i, i + 30);
          const childUpdatesSnapshot = await db
            .collection("updates")
            .where("childId", "in", batch)
            .orderBy("createdAt", "desc")
            .limit(limit)
            .get();

          childUpdatesSnapshot.docs.forEach((doc) => {
            updates.push({ id: doc.id, ...doc.data() } as UpdateData & {
              id: string;
            });
          });
        }
      }

      // 5b. Get orphanage-level updates (childId is null AND orphanageId in relevantOrphanageIds)
      if (relevantOrphanageIds.length > 0) {
        for (let i = 0; i < relevantOrphanageIds.length; i += 30) {
          const batch = relevantOrphanageIds.slice(i, i + 30);
          const orphanageUpdatesSnapshot = await db
            .collection("updates")
            .where("orphanageId", "in", batch)
            .where("childId", "==", null)
            .orderBy("createdAt", "desc")
            .limit(limit)
            .get();

          orphanageUpdatesSnapshot.docs.forEach((doc) => {
            updates.push({ id: doc.id, ...doc.data() } as UpdateData & {
              id: string;
            });
          });
        }
      }

      // 6. Sort all updates by createdAt desc and apply pagination
      updates.sort((a, b) => {
        const aTime =
          a.createdAt instanceof Date
            ? a.createdAt.getTime()
            : a.createdAt.toDate().getTime();
        const bTime =
          b.createdAt instanceof Date
            ? b.createdAt.getTime()
            : b.createdAt.toDate().getTime();
        return bTime - aTime;
      });

      // Remove duplicates (in case a child update also matches orphanage)
      const seen = new Set<string>();
      const uniqueUpdates = updates.filter((update) => {
        if (seen.has(update.id)) return false;
        seen.add(update.id);
        return true;
      });

      // Apply pagination with lastUpdateId
      let startIndex = 0;
      if (lastUpdateId) {
        const lastIndex = uniqueUpdates.findIndex((u) => u.id === lastUpdateId);
        if (lastIndex !== -1) {
          startIndex = lastIndex + 1;
        }
      }

      const paginatedUpdates = uniqueUpdates.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < uniqueUpdates.length;
      const newLastUpdateId =
        paginatedUpdates.length > 0
          ? paginatedUpdates[paginatedUpdates.length - 1].id
          : null;

      logger.info(
        `Returning ${paginatedUpdates.length} updates, hasMore: ${hasMore}`
      );

      res.json({
        updates: paginatedUpdates,
        hasMore,
        lastUpdateId: newLastUpdateId,
      });
    } catch (error) {
      logger.error("getUpdatesForDonor error", error);
      res.status(500).send("Internal error");
    }
  }
);
