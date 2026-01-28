import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";

interface FAQ {
  id: string;
  question: string;
  answer: string;
  order: number;
}

export const getFAQs = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    if (handleCors(req, res, allowedOrigins)) return;

    try {
      logger.info("getFAQs triggered");

      // Query FAQs ordered by the order field
      const snapshot = await db
        .collection("faqs")
        .orderBy("order", "asc")
        .get();

      const faqs: FAQ[] = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          question: data.question || "",
          answer: data.answer || "",
          order: data.order || 0,
        };
      });

      logger.info(`Returning ${faqs.length} FAQs`);

      res.json({
        data: {
          faqs,
        },
      });
    } catch (error) {
      logger.error("getFAQs error", error);
      res.status(500).send("Internal error");
    }
  }
);
