// functions/src/getDashboardStats.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";

interface PaymentTimePoint {
  date: string;
  amount: number;
  count: number;
}

interface DonorTimePoint {
  date: string;
  count: number;
}

interface TopDonor {
  donorId: string;
  name: string;
  totalAmount: number;
  donationCount: number;
}

interface TopOrphanage {
  orphanageId: string;
  name: string;
  totalReceived: number;
  donationCount: number;
}

interface DashboardStatsResponse {
  totalDonations: number;
  totalDonors: number;
  totalPayments: number;
  activeRecurringPlans: number;
  mrr: number;
  monthlyRecurringTip: number;
  periodStart: string;
  periodEnd: string;
  paymentsOverTime: PaymentTimePoint[];
  donorsOverTime: DonorTimePoint[];
  topDonors: TopDonor[];
  topOrphanages?: TopOrphanage[];
}

function getStartDate(range: string): Date {
  const now = new Date();
  switch (range) {
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case "year":
      return new Date(now.getFullYear(), 0, 1);
    case "all":
    default:
      return new Date(2020, 0, 1); // Beginning of time for this app
  }
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0]; // YYYY-MM-DD
}

function groupByDate(
  items: Array<{ date: Date; amount: number }>,
  range: string
): PaymentTimePoint[] {
  const grouped = new Map<string, { amount: number; count: number }>();

  items.forEach((item) => {
    let key: string;
    if (range === "year" || range === "all") {
      // Group by month
      key = `${item.date.getFullYear()}-${String(item.date.getMonth() + 1).padStart(2, "0")}`;
    } else {
      // Group by day
      key = formatDate(item.date);
    }

    const existing = grouped.get(key) || { amount: 0, count: 0 };
    grouped.set(key, {
      amount: existing.amount + item.amount,
      count: existing.count + 1,
    });
  });

  return Array.from(grouped.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export const getDashboardStats = onRequest(
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
          `getDashboardStats triggered by ${decoded.uid}, superAdmin=${isSuperAdmin}, orphanageId=${orphanageId}`
        );
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const { dateRange = "30d" } = req.body;
      const startDate = getStartDate(dateRange);
      const endDate = new Date();

      // If orphanageAdmin, they can only see their orphanage data
      if (!isSuperAdmin && !orphanageId) {
        res.status(403).send("Forbidden: No orphanage associated");
        return;
      }

      // 1. Fetch donations
      let donationsQuery = db
        .collection("donations")
        .where("status", "==", "success")
        .where("createdAt", ">=", startDate);

      if (!isSuperAdmin && orphanageId) {
        donationsQuery = donationsQuery.where("orphanageId", "==", orphanageId);
      }

      const donationsSnapshot = await donationsQuery.get();

      let totalDonations = 0;
      const uniqueDonorIds = new Set<string>();
      const donationsByDate: Array<{ date: Date; amount: number }> = [];
      const donorsByOrphanage = new Map<
        string,
        { amount: number; count: number }
      >();
      const donorTotals = new Map<string, { amount: number; count: number }>();

      donationsSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        const amount = data.baseAmount || data.amount || 0;
        totalDonations += amount;

        if (data.donorUid) {
          uniqueDonorIds.add(data.donorUid);
          const existing = donorTotals.get(data.donorUid) || {
            amount: 0,
            count: 0,
          };
          donorTotals.set(data.donorUid, {
            amount: existing.amount + amount,
            count: existing.count + 1,
          });
        }

        if (data.orphanageId) {
          const existing = donorsByOrphanage.get(data.orphanageId) || {
            amount: 0,
            count: 0,
          };
          donorsByOrphanage.set(data.orphanageId, {
            amount: existing.amount + amount,
            count: existing.count + 1,
          });
        }

        const createdAt = data.createdAt?.toDate?.() || new Date(data.createdAt);
        donationsByDate.push({ date: createdAt, amount });
      });

      // 2. Get active recurring plans and MRR
      let recurringQuery = db
        .collection("recurringPlans")
        .where("status", "==", "active");

      if (!isSuperAdmin && orphanageId) {
        recurringQuery = recurringQuery.where("orphanageId", "==", orphanageId);
      }

      const recurringSnapshot = await recurringQuery.get();
      let mrr = 0;
      let monthlyRecurringTip = 0;

      recurringSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        const baseAmount = data.baseAmount || 0;
        const tipAmount = data.tipAmount || 0;
        const interval = data.interval?.toLowerCase() || "monthly";

        // Convert to monthly equivalent
        let multiplier = 1;
        switch (interval) {
          case "daily":
            multiplier = 30;
            break;
          case "weekly":
            multiplier = 4;
            break;
          case "quarterly":
            multiplier = 1 / 3;
            break;
          case "yearly":
            multiplier = 1 / 12;
            break;
          case "monthly":
          default:
            multiplier = 1;
            break;
        }

        mrr += baseAmount * multiplier;
        monthlyRecurringTip += tipAmount * multiplier;
      });

      // 3. Get donor names for top donors
      const sortedDonors = Array.from(donorTotals.entries())
        .map(([donorId, data]) => ({ donorId, ...data }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10);

      const donorIds = sortedDonors.map((d) => d.donorId);
      const donorNames = new Map<string, string>();

      if (donorIds.length > 0) {
        const donorRefs = donorIds.map((id) => db.collection("donors").doc(id));
        const donorDocs = await db.getAll(...donorRefs);
        donorDocs.forEach((doc) => {
          if (doc.exists) {
            const data = doc.data();
            donorNames.set(doc.id, data?.name || "Anonymous");
          }
        });
      }

      const topDonors: TopDonor[] = sortedDonors.map((d) => ({
        donorId: d.donorId,
        name: donorNames.get(d.donorId) || "Anonymous",
        totalAmount: d.amount,
        donationCount: d.count,
      }));

      // 4. Get top orphanages (superAdmin only)
      let topOrphanages: TopOrphanage[] | undefined;

      if (isSuperAdmin) {
        const sortedOrphanages = Array.from(donorsByOrphanage.entries())
          .map(([orphanageId, data]) => ({ orphanageId, ...data }))
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 10);

        const orphanageIds = sortedOrphanages.map((o) => o.orphanageId);
        const orphanageNames = new Map<string, string>();

        if (orphanageIds.length > 0) {
          const orphanageRefs = orphanageIds.map((id) =>
            db.collection("orphanages").doc(id)
          );
          const orphanageDocs = await db.getAll(...orphanageRefs);
          orphanageDocs.forEach((doc) => {
            if (doc.exists) {
              const data = doc.data();
              orphanageNames.set(doc.id, data?.name || "Unknown Orphanage");
            }
          });
        }

        topOrphanages = sortedOrphanages.map((o) => ({
          orphanageId: o.orphanageId,
          name: orphanageNames.get(o.orphanageId) || "Unknown Orphanage",
          totalReceived: o.amount,
          donationCount: o.count,
        }));
      }

      // 5. Build time series data
      const paymentsOverTime = groupByDate(donationsByDate, dateRange);

      // 6. Build donor growth time series (new donors by date)
      // For simplicity, we track unique donors per time period
      const donorGrowthMap = new Map<string, Set<string>>();
      donationsSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        if (!data.donorUid) return;

        const createdAt = data.createdAt?.toDate?.() || new Date(data.createdAt);
        let key: string;
        if (dateRange === "year" || dateRange === "all") {
          key = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
        } else {
          key = formatDate(createdAt);
        }

        if (!donorGrowthMap.has(key)) {
          donorGrowthMap.set(key, new Set());
        }
        donorGrowthMap.get(key)!.add(data.donorUid);
      });

      const donorsOverTime: DonorTimePoint[] = Array.from(donorGrowthMap.entries())
        .map(([date, donors]) => ({ date, count: donors.size }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const response: DashboardStatsResponse = {
        totalDonations,
        totalDonors: uniqueDonorIds.size,
        totalPayments: donationsSnapshot.size,
        activeRecurringPlans: recurringSnapshot.size,
        mrr: Math.round(mrr),
        monthlyRecurringTip: Math.round(monthlyRecurringTip),
        periodStart: formatDate(startDate),
        periodEnd: formatDate(endDate),
        paymentsOverTime,
        donorsOverTime,
        topDonors,
        topOrphanages,
      };

      logger.info(
        `Returning dashboard stats: ${donationsSnapshot.size} payments, ${uniqueDonorIds.size} donors`
      );
      res.json({ data: response });
    } catch (error) {
      logger.error("getDashboardStats error", error);
      res.status(500).send("Internal error");
    }
  }
);
