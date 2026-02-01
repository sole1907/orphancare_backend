// functions/src/getDonorStats.ts
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";

// Leaderboard tier thresholds (in NGN)
const TIER_THRESHOLDS = {
  diamond: 1000000,
  platinum: 500000,
  gold: 200000,
  silver: 100000,
  bronze: 50000,
  supporter: 1,
};

interface LeaderboardData {
  tier: string;
  tierThreshold: number;
  nextTier: string | null;
  nextTierThreshold: number | null;
  progressToNext: number;
  rank: number | null;
  percentile: number;
}

interface DonorStatsResponse {
  donationsThisMonth: number;
  amountThisMonth: number;
  childrenSupportedThisMonth: number;
  unreadUpdatesCount: number;
  lifetimeDonations: number;
  lifetimeDonationCount: number;
  leaderboard: LeaderboardData;
}

function getTierForAmount(amount: number): { tier: string; threshold: number } {
  if (amount >= TIER_THRESHOLDS.diamond)
    return { tier: "diamond", threshold: TIER_THRESHOLDS.diamond };
  if (amount >= TIER_THRESHOLDS.platinum)
    return { tier: "platinum", threshold: TIER_THRESHOLDS.platinum };
  if (amount >= TIER_THRESHOLDS.gold)
    return { tier: "gold", threshold: TIER_THRESHOLDS.gold };
  if (amount >= TIER_THRESHOLDS.silver)
    return { tier: "silver", threshold: TIER_THRESHOLDS.silver };
  if (amount >= TIER_THRESHOLDS.bronze)
    return { tier: "bronze", threshold: TIER_THRESHOLDS.bronze };
  return { tier: "supporter", threshold: TIER_THRESHOLDS.supporter };
}

function getNextTier(
  currentTier: string
): { tier: string; threshold: number } | null {
  const tiers = ["supporter", "bronze", "silver", "gold", "platinum", "diamond"];
  const currentIndex = tiers.indexOf(currentTier);
  if (currentIndex === -1 || currentIndex === tiers.length - 1) return null;

  const nextTierName = tiers[currentIndex + 1];
  return {
    tier: nextTierName,
    threshold: TIER_THRESHOLDS[nextTierName as keyof typeof TIER_THRESHOLDS],
  };
}

export const getDonorStats = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      // Auth check - must be a donor
      let donorUid: string;
      try {
        const decoded = await verifyAuth(req, { requiredRoles: ["donor"] });
        donorUid = decoded.uid;
        logger.info(`getDonorStats triggered by ${donorUid}`);
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      // 1. Get start of current month
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      // 2. Get donations for this month
      const monthDonationsSnapshot = await db
        .collection("donations")
        .where("donorUid", "==", donorUid)
        .where("status", "==", "success")
        .where("createdAt", ">=", startOfMonth)
        .get();

      let amountThisMonth = 0;
      const childrenThisMonth = new Set<string>();

      monthDonationsSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        amountThisMonth += data.baseAmount || data.amount || 0;
        if (data.childId) childrenThisMonth.add(data.childId);
      });

      // 3. Get donor document for lifetime stats
      const donorDoc = await db.collection("donors").doc(donorUid).get();
      const donorData = donorDoc.data();

      const lifetimeDonations = donorData?.lifetimeDonations || 0;
      const lifetimeDonationCount = donorData?.lifetimeDonationCount || 0;
      const lastUpdatesViewedAt = donorData?.lastUpdatesViewedAt?.toDate?.() || null;

      // 4. Get unread updates count
      let unreadUpdatesCount = 0;

      // 4a. Get followed childIds
      const followedSnapshot = await db
        .collection("donor_follows")
        .doc(donorUid)
        .collection("follows")
        .get();
      const followedChildIds = followedSnapshot.docs.map((doc) => doc.id);

      // 4b. Get donated-to orphanageIds (last 12 months)
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

      const donationsSnapshot = await db
        .collection("donations")
        .where("donorUid", "==", donorUid)
        .where("status", "==", "success")
        .where("createdAt", ">=", twelveMonthsAgo)
        .get();

      const donatedChildIds = new Set<string>();
      const donatedOrphanageIds = new Set<string>();

      donationsSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        if (data.childId) donatedChildIds.add(data.childId);
        if (data.orphanageId) donatedOrphanageIds.add(data.orphanageId);
      });

      const relevantChildIds = Array.from(
        new Set([...followedChildIds, ...donatedChildIds])
      );
      const relevantOrphanageIds = Array.from(donatedOrphanageIds);

      // 4c. Count unread updates
      if (relevantChildIds.length > 0 || relevantOrphanageIds.length > 0) {
        // Count child updates
        for (let i = 0; i < relevantChildIds.length; i += 30) {
          const batch = relevantChildIds.slice(i, i + 30);
          let query = db.collection("updates").where("childId", "in", batch);

          if (lastUpdatesViewedAt) {
            query = query.where("createdAt", ">", lastUpdatesViewedAt);
          }

          const snapshot = await query.get();
          unreadUpdatesCount += snapshot.size;
        }

        // Count orphanage-level updates
        for (let i = 0; i < relevantOrphanageIds.length; i += 30) {
          const batch = relevantOrphanageIds.slice(i, i + 30);
          let query = db
            .collection("updates")
            .where("orphanageId", "in", batch)
            .where("childId", "==", null);

          if (lastUpdatesViewedAt) {
            query = query.where("createdAt", ">", lastUpdatesViewedAt);
          }

          const snapshot = await query.get();
          unreadUpdatesCount += snapshot.size;
        }
      }

      // 5. Calculate leaderboard position
      const { tier, threshold: tierThreshold } = getTierForAmount(lifetimeDonations);
      const nextTierInfo = getNextTier(tier);

      let progressToNext = 1.0; // Default to 100% if at top tier
      if (nextTierInfo) {
        const amountInCurrentTier = lifetimeDonations - tierThreshold;
        const amountNeededForNext = nextTierInfo.threshold - tierThreshold;
        progressToNext = Math.min(
          1.0,
          Math.max(0, amountInCurrentTier / amountNeededForNext)
        );
      }

      // 5b. Get percentile from cached leaderboard (or estimate)
      let rank: number | null = null;
      let percentile = 50; // Default

      const leaderboardDoc = await db
        .collection("donorLeaderboard")
        .doc("current")
        .get();

      if (leaderboardDoc.exists) {
        const leaderboardData = leaderboardDoc.data();
        const totalDonors = leaderboardData?.totalDonors || 1;
        const thresholds = leaderboardData?.percentileThresholds || {};

        // Calculate percentile based on thresholds
        if (lifetimeDonations >= (thresholds.p1 || Infinity)) {
          percentile = 1;
        } else if (lifetimeDonations >= (thresholds.p5 || Infinity)) {
          percentile = 5;
        } else if (lifetimeDonations >= (thresholds.p10 || Infinity)) {
          percentile = 10;
        } else if (lifetimeDonations >= (thresholds.p25 || Infinity)) {
          percentile = 25;
        } else if (lifetimeDonations >= (thresholds.p50 || Infinity)) {
          percentile = 50;
        } else {
          percentile = 100;
        }

        // Check if user is in top 100
        const topDonors = leaderboardData?.topDonors || [];
        const userRankEntry = topDonors.find(
          (d: { donorUid: string }) => d.donorUid === donorUid
        );
        if (userRankEntry) {
          rank = userRankEntry.rank;
        }
      }

      const response: DonorStatsResponse = {
        donationsThisMonth: monthDonationsSnapshot.size,
        amountThisMonth,
        childrenSupportedThisMonth: childrenThisMonth.size,
        unreadUpdatesCount,
        lifetimeDonations,
        lifetimeDonationCount,
        leaderboard: {
          tier,
          tierThreshold,
          nextTier: nextTierInfo?.tier || null,
          nextTierThreshold: nextTierInfo?.threshold || null,
          progressToNext,
          rank,
          percentile,
        },
      };

      logger.info(`Returning donor stats for ${donorUid}`);
      res.json({ data: response });
    } catch (error) {
      logger.error("getDonorStats error", error);
      res.status(500).send("Internal error");
    }
  }
);
