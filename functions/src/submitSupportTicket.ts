import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { db } from "./lib/firebaseAdmin";
import { verifyAuth } from "./lib/authUtils";
import { handleCors } from "./lib/corsUtils";
import { allowedOrigins } from "./config/constants";
import { FieldValue } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import Brevo from "sib-api-v3-sdk";

const brevoApiKey = defineSecret("BREVO_API_KEY");

export const submitSupportTicket = onRequest(
  { region: "europe-west1", secrets: [brevoApiKey] },
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
        logger.info(`submitSupportTicket triggered by ${donorUid}`);
      } catch (err: any) {
        logger.error("Auth error", err);
        res.status(err.code || 401).send(err.message || "Unauthorized");
        return;
      }

      const { category, subject, message } = req.body;

      // Validate category
      const validCategories = [
        "general",
        "donation",
        "account",
        "technical",
        "other",
      ];
      if (!category || !validCategories.includes(category)) {
        res
          .status(400)
          .send(`Category must be one of: ${validCategories.join(", ")}`);
        return;
      }

      // Validate subject
      if (
        !subject ||
        typeof subject !== "string" ||
        subject.trim().length === 0
      ) {
        res.status(400).send("Subject is required");
        return;
      }

      // Validate message
      if (
        !message ||
        typeof message !== "string" ||
        message.trim().length === 0
      ) {
        res.status(400).send("Message is required");
        return;
      }

      // Get donor name from Firestore
      let donorName = "Unknown Donor";
      try {
        const donorDoc = await db.collection("donors").doc(donorUid).get();
        if (donorDoc.exists) {
          const donorData = donorDoc.data();
          donorName =
            donorData?.name || donorData?.displayName || "Unknown Donor";
        }
      } catch (err) {
        logger.warn("Could not fetch donor name", err);
      }

      // Store support ticket in Firestore
      const ticketRef = db.collection("supportTickets").doc();
      await ticketRef.set({
        ticketId: ticketRef.id,
        donorUid,
        donorEmail,
        donorName,
        category,
        subject: subject.trim(),
        message: message.trim(),
        status: "open",
        createdAt: FieldValue.serverTimestamp(),
      });

      // Send email to support
      const categoryLabels: Record<string, string> = {
        general: "General Inquiry",
        donation: "Donation Issue",
        account: "Account Issue",
        technical: "Technical Problem",
        other: "Other",
      };

      const emailSubject = `[Benevovia Support] ${categoryLabels[category]}: ${subject.trim()}`;

      try {
        const client = Brevo.ApiClient.instance;
        client.authentications["api-key"].apiKey = brevoApiKey.value();

        const apiInstance = new Brevo.TransactionalEmailsApi();

        await apiInstance.sendTransacEmail({
          sender: {
            email: process.env.SENDER_EMAIL || "sola.akanmu@gmail.com",
            name: process.env.SENDER_NAME || "Benevovia",
          },
          to: [{ email: "support@benevovia.com" }],
          replyTo: { email: donorEmail, name: donorName },
          subject: emailSubject,
          htmlContent: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; background-color: #f9f9f9; border-radius: 8px;">
              <h2 style="color: #1e3a8a;">New Support Ticket</h2>
              <p><strong>From:</strong> ${donorName} (${donorEmail})</p>
              <p><strong>Category:</strong> ${categoryLabels[category]}</p>
              <p><strong>Subject:</strong> ${subject.trim()}</p>
              <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;" />
              <p><strong>Message:</strong></p>
              <p style="white-space: pre-wrap;">${message.trim()}</p>
              <hr style="border: none; border-top: 1px solid #ddd; margin: 16px 0;" />
              <p style="font-size: 12px; color: #555;">
                Ticket ID: ${ticketRef.id}<br />
                Donor UID: ${donorUid}
              </p>
            </div>
          `,
        });
        logger.info(`Support email sent for ticket ${ticketRef.id}`);
      } catch (emailErr) {
        logger.error("Failed to send support email", emailErr);
        // Don't fail the request, ticket is still saved
      }

      logger.info(
        `Support ticket created: ${ticketRef.id}, category: ${category}`,
      );

      res.json({
        success: true,
        message:
          "Your message has been sent. We'll respond to your email within 24-48 hours.",
        ticketId: ticketRef.id,
      });
    } catch (error) {
      logger.error("submitSupportTicket error", error);
      res.status(500).send("Internal error");
    }
  },
);
