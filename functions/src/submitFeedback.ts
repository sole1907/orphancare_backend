import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { FieldValue } from "firebase-admin/firestore";

export const submitFeedback = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      // Auth check - must be a donor
      let donorUid: string;
      let donorEmail: string;
      try {
        const decoded = await verifyAuth(req, { requiredRoles: ["donor"] });
        donorUid = decoded.uid;
        donorEmail = decoded.email || "";
        logger.info(`submitFeedback triggered by ${donorUid}`);
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const { rating, category, message } = req.body;

      // Validate rating
      if (typeof rating !== "number" || rating < 1 || rating > 5) {
        res.status(400).send("Rating must be a number between 1 and 5");
        return;
      }

      // Validate category
      const validCategories = ["suggestion", "complaint", "compliment", "general"];
      if (!category || !validCategories.includes(category)) {
        res
          .status(400)
          .send(
            `Category must be one of: ${validCategories.join(", ")}`
          );
        return;
      }

      // Create feedback document
      const feedbackRef = db.collection("feedback").doc();
      await feedbackRef.set({
        feedbackId: feedbackRef.id,
        donorUid,
        donorEmail,
        rating,
        category,
        message: message || null,
        createdAt: FieldValue.serverTimestamp(),
      });

      logger.info(
        `Feedback submitted: ${feedbackRef.id}, rating: ${rating}, category: ${category}`
      );

      res.json({
        success: true,
        message: "Thank you for your feedback!",
        feedbackId: feedbackRef.id,
      });
    } catch (error) {
      logger.error("submitFeedback error", error);
      res.status(500).send("Internal error");
    }
  }
);
