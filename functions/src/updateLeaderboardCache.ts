// functions/src/updateLeaderboardCache.ts
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";

interface DonorLeaderboardEntry {
  donorUid: string;
  totalAmount: number;
  rank: number;
}

interface LeaderboardCache {
  lastUpdated: Date;
  totalDonors: number;
  percentileThresholds: {
    p1: number;
    p5: number;
    p10: number;
    p25: number;
    p50: number;
  };
  topDonors: DonorLeaderboardEntry[];
}

export const updateLeaderboardCache = onSchedule(
  {
    schedule: "every 6 hours",
    timeZone: "Africa/Lagos",
    region: "europe-west1",
  },
  async () => {
    logger.info("updateLeaderboardCache started");

    try {
      // 1. Get all donors with lifetimeDonations > 0
      const donorsSnapshot = await db
        .collection("donors")
        .where("lifetimeDonations", ">", 0)
        .get();

      if (donorsSnapshot.empty) {
        logger.info("No donors with donations found");
        await db.collection("donorLeaderboard").doc("current").set({
          lastUpdated: new Date(),
          totalDonors: 0,
          percentileThresholds: { p1: 0, p5: 0, p10: 0, p25: 0, p50: 0 },
          topDonors: [],
        });
        return;
      }

      // 2. Extract and sort donors by lifetime donations
      const donorAmounts: Array<{ donorUid: string; totalAmount: number }> = [];

      donorsSnapshot.docs.forEach((doc) => {
        const data = doc.data();
        donorAmounts.push({
          donorUid: doc.id,
          totalAmount: data.lifetimeDonations || 0,
        });
      });

      // Sort descending by amount
      donorAmounts.sort((a, b) => b.totalAmount - a.totalAmount);

      const totalDonors = donorAmounts.length;

      // 3. Calculate percentile thresholds
      const getPercentileValue = (percentile: number): number => {
        // Index for top X% - e.g., for top 1%, we get the value at index 0.01 * totalDonors
        const index = Math.max(
          0,
          Math.floor((percentile / 100) * totalDonors) - 1
        );
        return donorAmounts[index]?.totalAmount || 0;
      };

      const percentileThresholds = {
        p1: getPercentileValue(1),
        p5: getPercentileValue(5),
        p10: getPercentileValue(10),
        p25: getPercentileValue(25),
        p50: getPercentileValue(50),
      };

      // 4. Get top 100 donors with ranks
      const topDonors: DonorLeaderboardEntry[] = donorAmounts
        .slice(0, 100)
        .map((donor, index) => ({
          donorUid: donor.donorUid,
          totalAmount: donor.totalAmount,
          rank: index + 1,
        }));

      // 5. Save to Firestore
      const leaderboardCache: LeaderboardCache = {
        lastUpdated: new Date(),
        totalDonors,
        percentileThresholds,
        topDonors,
      };

      await db
        .collection("donorLeaderboard")
        .doc("current")
        .set(leaderboardCache);

      logger.info(
        `Leaderboard cache updated: ${totalDonors} donors, top threshold: ${percentileThresholds.p1}`
      );
    } catch (error) {
      logger.error("updateLeaderboardCache error", error);
      throw error;
    }
  }
);
