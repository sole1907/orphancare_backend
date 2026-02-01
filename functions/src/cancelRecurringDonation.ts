import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { FieldValue } from "firebase-admin/firestore";

export const cancelRecurringDonation = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      // Auth check - must be a donor
      let donorUid: string;
      try {
        const decoded = await verifyAuth(req, { requiredRoles: ["donor"] });
        donorUid = decoded.uid;
        logger.info(`cancelRecurringDonation triggered by ${donorUid}`);
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const { planCode, cancellationReason } = req.body;

      if (!planCode) {
        res.status(400).send("planCode is required");
        return;
      }

      // Find the recurring plan
      const planSnapshot = await db
        .collection("recurringPlans")
        .where("planCode", "==", planCode)
        .limit(1)
        .get();

      if (planSnapshot.empty) {
        res.status(404).send("Recurring plan not found");
        return;
      }

      const planDoc = planSnapshot.docs[0];
      const planData = planDoc.data();

      // Verify ownership
      if (planData.donorUid !== donorUid) {
        logger.warn(
          `Unauthorized cancellation attempt: ${donorUid} tried to cancel plan owned by ${planData.donorUid}`
        );
        res.status(403).send("You do not have permission to cancel this plan");
        return;
      }

      // Check if plan can be cancelled
      const cancellableStatuses = ["active", "pending"];
      if (!cancellableStatuses.includes(planData.status)) {
        res
          .status(400)
          .send(`Cannot cancel a plan with status: ${planData.status}`);
        return;
      }

      // Update the plan
      await planDoc.ref.update({
        status: "cancelled",
        cancelledAt: FieldValue.serverTimestamp(),
        cancellationReason: cancellationReason || null,
      });

      logger.info(
        `Recurring plan ${planCode} cancelled by ${donorUid}. Reason: ${
          cancellationReason || "Not specified"
        }`
      );

      res.json({
        success: true,
        message: "Recurring donation cancelled successfully",
      });
    } catch (error) {
      logger.error("cancelRecurringDonation error", error);
      res.status(500).send("Internal error");
    }
  }
);
