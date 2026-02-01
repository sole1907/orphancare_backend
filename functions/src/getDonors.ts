// functions/src/getDonors.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";

interface DonorListItem {
  donorUid: string;
  name: string;
  email: string;
  totalAmount: number;
  donationCount: number;
  lastDonationAt: string | null;
}

interface DonorsListResponse {
  donors: DonorListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const getDonors = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      // Auth check - must be superAdmin or orphanageAdmin
      let isSuperAdmin = false;
      let orphanageId: string | null = null;

      try {
        const decoded = await verifyAuth(req, {
          requiredRoles: ["superAdmin", "orphanageAdmin"],
        });

        isSuperAdmin = !!decoded.superAdmin;
        orphanageId = decoded.orphanageId as string | null;

        logger.info(
          `getDonors triggered by ${decoded.uid}, superAdmin=${isSuperAdmin}, orphanageId=${orphanageId}`
        );
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const { page = 1, pageSize = 10, search = "" } = req.body;
      const searchLower = search.toLowerCase();

      const donorsList: DonorListItem[] = [];

      if (isSuperAdmin) {
        // Super Admin: Get all donors from /donors collection
        const donorsSnapshot = await db.collection("donors").get();

        for (const doc of donorsSnapshot.docs) {
          const donorData = doc.data();
          const donorUid = doc.id;
          const name = donorData.name ?? "";
          const email = donorData.email ?? "";

          // Apply search filter
          if (
            searchLower &&
            !name.toLowerCase().includes(searchLower) &&
            !email.toLowerCase().includes(searchLower)
          ) {
            continue;
          }

          // Get donation stats
          const donationsSnapshot = await db
            .collection("donations")
            .where("donorUid", "==", donorUid)
            .get();

          let totalAmount = 0;
          let donationCount = 0;
          let lastDonationAt: string | null = null;

          donationsSnapshot.docs.forEach((donationDoc) => {
            const donation = donationDoc.data();
            if (donation.status === "success") {
              totalAmount += donation.baseAmount ?? 0;
              donationCount++;
              const createdAt = donation.createdAt?.toDate?.()?.toISOString?.();
              if (createdAt && (!lastDonationAt || createdAt > lastDonationAt)) {
                lastDonationAt = createdAt;
              }
            }
          });

          donorsList.push({
            donorUid,
            name,
            email,
            totalAmount,
            donationCount,
            lastDonationAt,
          });
        }
      } else if (orphanageId) {
        // Orphanage Admin: Aggregate donors from donations to this orphanage
        const donationsSnapshot = await db
          .collection("donations")
          .where("orphanageId", "==", orphanageId)
          .get();

        const donorMap = new Map<
          string,
          {
            totalAmount: number;
            donationCount: number;
            lastDonationAt: string | null;
          }
        >();

        donationsSnapshot.docs.forEach((doc) => {
          const donation = doc.data();
          if (donation.status === "success" && donation.donorUid) {
            const donorUid = donation.donorUid;
            const existing = donorMap.get(donorUid) ?? {
              totalAmount: 0,
              donationCount: 0,
              lastDonationAt: null,
            };
            existing.totalAmount += donation.baseAmount ?? 0;
            existing.donationCount++;
            const createdAt = donation.createdAt?.toDate?.()?.toISOString?.();
            if (
              createdAt &&
              (!existing.lastDonationAt || createdAt > existing.lastDonationAt)
            ) {
              existing.lastDonationAt = createdAt;
            }
            donorMap.set(donorUid, existing);
          }
        });

        // Get donor details for each unique donor
        for (const [donorUid, stats] of donorMap) {
          const donorDoc = await db.collection("donors").doc(donorUid).get();
          const donorData = donorDoc.data() ?? {};
          const name = donorData.name ?? "";
          const email = donorData.email ?? "";

          // Apply search filter
          if (
            searchLower &&
            !name.toLowerCase().includes(searchLower) &&
            !email.toLowerCase().includes(searchLower)
          ) {
            continue;
          }

          donorsList.push({
            donorUid,
            name,
            email,
            totalAmount: stats.totalAmount,
            donationCount: stats.donationCount,
            lastDonationAt: stats.lastDonationAt,
          });
        }
      }

      // Sort by totalAmount descending
      donorsList.sort((a, b) => b.totalAmount - a.totalAmount);

      // Apply pagination
      const total = donorsList.length;
      const totalPages = Math.ceil(total / pageSize);
      const startIndex = (page - 1) * pageSize;
      const paginatedDonors = donorsList.slice(startIndex, startIndex + pageSize);

      const response: DonorsListResponse = {
        donors: paginatedDonors,
        total,
        page,
        pageSize,
        totalPages,
      };

      logger.info(`Returning ${paginatedDonors.length} of ${total} donors`);
      res.json({ data: response });
    } catch (error) {
      logger.error("getDonors error", error);
      res.status(500).send("Internal error");
    }
  }
);
