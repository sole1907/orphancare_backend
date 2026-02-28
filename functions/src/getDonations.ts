// functions/src/getDonations.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { decryptPII, EncryptedField } from "./lib/encryption";
import { defineSecret } from "firebase-functions/params";

const devEncryptionKey = defineSecret("DEV_ENCRYPTION_KEY");

type DonationStatus = "pending" | "success" | "failed";

interface DonationListItem {
  donationId: string;
  donorName: string;
  donorEmail: string;
  orphanageName?: string;
  amount: number;
  netAmount: number;
  tipAmount: number;
  paystackFee: number;
  status: DonationStatus;
  recurring: boolean;
  createdAt: string;
  childId?: string;
  childName?: string;
  childPhoto?: string;
  childGender?: string;
  childStory?: string;
  childDateOfBirth?: string;
  childHobbies?: string[];
}

interface DonationsListResponse {
  donations: DonationListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Extract donor PII fields, handling both encrypted and plaintext formats
 */
async function extractDonorPII(
  donorData: any
): Promise<{ name: string; email: string }> {
  let name = "";
  let email = "";

  // Try encrypted fields first, fall back to plaintext
  if (donorData.name_encrypted) {
    try {
      name = await decryptPII(donorData.name_encrypted as EncryptedField);
    } catch {
      name = donorData.name ?? "";
    }
  } else {
    name = donorData.name ?? "";
  }

  if (donorData.email_encrypted) {
    try {
      email = await decryptPII(donorData.email_encrypted as EncryptedField);
    } catch {
      email = donorData.email ?? "";
    }
  } else {
    email = donorData.email ?? "";
  }

  return { name, email };
}

/**
 * Extract child name, handling both encrypted and plaintext formats
 */
async function extractChildName(childData: any): Promise<string> {
  // Try encrypted field first, fall back to plaintext
  if (childData.name_encrypted) {
    try {
      return await decryptPII(childData.name_encrypted as EncryptedField);
    } catch {
      return childData.name ?? "Unknown";
    }
  }
  return childData.name ?? "Unknown";
}

/**
 * Extract child birthday/date of birth, handling both encrypted and plaintext formats
 */
async function extractChildDateOfBirth(childData: any): Promise<string | null> {
  // Try encrypted field first, fall back to plaintext
  if (childData.birthday_encrypted) {
    try {
      return await decryptPII(childData.birthday_encrypted as EncryptedField);
    } catch {
      return childData.birthday ?? null;
    }
  }
  return childData.birthday ?? null;
}

export const getDonations = onRequest(
  { region: "europe-west1", secrets: [devEncryptionKey] },
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
          `getDonations triggered by ${decoded.uid}, superAdmin=${isSuperAdmin}, orphanageId=${orphanageId}`
        );
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const {
        page = 1,
        pageSize = 10,
        search = "",
        status: statusFilter = "all",
        startDate: startDateStr,
        endDate: endDateStr,
      } = req.body;

      const searchLower = search.toLowerCase();
      const startDate = startDateStr ? new Date(startDateStr) : null;
      const endDate = endDateStr ? new Date(endDateStr) : null;

      // Build query
      let donationsQuery: FirebaseFirestore.Query = db.collection("donations");

      // Filter by orphanageId for orphanage admins
      if (!isSuperAdmin && orphanageId) {
        donationsQuery = donationsQuery.where("orphanageId", "==", orphanageId);
      }

      const donationsSnapshot = await donationsQuery.get();

      // Cache for donor, orphanage, and child data to reduce reads
      const donorCache = new Map<string, { name: string; email: string }>();
      const orphanageCache = new Map<string, string>();
      const childCache = new Map<string, { name: string; photo: string | null; gender: string | null; story: string | null; dateOfBirth: string | null; hobbies: string[] }>();

      const donationsList: DonationListItem[] = [];

      for (const doc of donationsSnapshot.docs) {
        const donation = doc.data();
        const donationId = doc.id;

        // Apply status filter
        const donationStatus = donation.status as DonationStatus;
        if (statusFilter !== "all" && donationStatus !== statusFilter) {
          continue;
        }

        // Apply date range filter
        const createdAt = donation.createdAt?.toDate?.();
        if (createdAt) {
          if (startDate && createdAt < startDate) {
            continue;
          }
          if (endDate) {
            const endOfDay = new Date(endDate);
            endOfDay.setHours(23, 59, 59, 999);
            if (createdAt > endOfDay) {
              continue;
            }
          }
        }

        // Get donor info
        const donorUid = donation.donorUid as string;
        let donorName = "";
        let donorEmail = "";

        if (donorUid) {
          if (donorCache.has(donorUid)) {
            const cached = donorCache.get(donorUid)!;
            donorName = cached.name;
            donorEmail = cached.email;
          } else {
            const donorDoc = await db.collection("donors").doc(donorUid).get();
            const donorData = donorDoc.data();
            if (donorData) {
              const pii = await extractDonorPII(donorData);
              donorName = pii.name;
              donorEmail = pii.email;
            }
            donorCache.set(donorUid, { name: donorName, email: donorEmail });
          }
        }

        // Apply search filter
        if (
          searchLower &&
          !donorName.toLowerCase().includes(searchLower) &&
          !donorEmail.toLowerCase().includes(searchLower)
        ) {
          continue;
        }

        // Get orphanage name for super admin
        let orphanageName: string | undefined;
        if (isSuperAdmin && donation.orphanageId) {
          const donationOrphanageId = donation.orphanageId as string;
          if (orphanageCache.has(donationOrphanageId)) {
            orphanageName = orphanageCache.get(donationOrphanageId);
          } else {
            const orphanageDoc = await db
              .collection("orphanages")
              .doc(donationOrphanageId)
              .get();
            const orphanageData = orphanageDoc.data();
            orphanageName = orphanageData?.name ?? "";
            orphanageCache.set(donationOrphanageId, orphanageName!);
          }
        }

        // Get child info
        let childId: string | undefined;
        let childName: string | undefined;
        let childPhoto: string | undefined;
        let childGender: string | undefined;
        let childStory: string | undefined;
        let childDateOfBirth: string | undefined;
        let childHobbies: string[] | undefined;

        if (donation.childId) {
          childId = donation.childId as string;
          if (childCache.has(childId)) {
            const cached = childCache.get(childId)!;
            childName = cached.name;
            childPhoto = cached.photo ?? undefined;
            childGender = cached.gender ?? undefined;
            childStory = cached.story ?? undefined;
            childDateOfBirth = cached.dateOfBirth ?? undefined;
            childHobbies = cached.hobbies;
          } else {
            const childDoc = await db.collection("children").doc(childId).get();
            const childData = childDoc.data();
            if (childData) {
              childName = await extractChildName(childData);
              childPhoto = childData.photoUrl ?? null;
              childGender = childData.gender ?? null;
              childStory = childData.story ?? null;
              childDateOfBirth = await extractChildDateOfBirth(childData) ?? undefined;
              childHobbies = childData.hobbies ?? [];
            }
            childCache.set(childId, {
              name: childName ?? "Unknown",
              photo: childPhoto ?? null,
              gender: childGender ?? null,
              story: childStory ?? null,
              dateOfBirth: childDateOfBirth ?? null,
              hobbies: childHobbies ?? [],
            });
          }
        }

        const baseAmount = donation.baseAmount ?? 0;
        const tipAmount = donation.tipAmount ?? 0;
        const paystackFee = donation.paystackFee ?? 0;
        const netAmount = donation.netAmount ?? baseAmount + tipAmount;

        donationsList.push({
          donationId,
          donorName,
          donorEmail,
          orphanageName,
          amount: baseAmount,
          netAmount,
          tipAmount,
          paystackFee,
          status: donationStatus,
          recurring: donation.recurring ?? false,
          createdAt: createdAt?.toISOString?.() ?? "",
          childId,
          childName,
          childPhoto,
          childGender,
          childStory,
          childDateOfBirth,
          childHobbies,
        });
      }

      // Sort by createdAt descending (most recent first)
      donationsList.sort((a, b) => {
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      });

      // Apply pagination
      const total = donationsList.length;
      const totalPages = Math.ceil(total / pageSize);
      const startIndex = (page - 1) * pageSize;
      const paginatedDonations = donationsList.slice(
        startIndex,
        startIndex + pageSize
      );

      const response: DonationsListResponse = {
        donations: paginatedDonations,
        total,
        page,
        pageSize,
        totalPages,
      };

      logger.info(
        `Returning ${paginatedDonations.length} of ${total} donations`
      );
      res.json({ data: response });
    } catch (error) {
      logger.error("getDonations error", error);
      res.status(500).send("Internal error");
    }
  }
);
