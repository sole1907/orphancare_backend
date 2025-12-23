import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { auth, db } from "./lib/firebaseAdmin";

const paystackSecret = defineSecret("PAYSTACK_SECRET_KEY");
const brevoApiKey = defineSecret("BREVO_API_KEY");

export const retrySplit = onRequest(
  { region: "europe-west1", secrets: [paystackSecret, brevoApiKey] },
  async (req, res) => {
    try {
      const idToken = req.headers.authorization?.split("Bearer ")[1];
      if (!idToken) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const decoded = await auth.verifyIdToken(idToken);
      if (decoded.role !== "superAdmin") {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const { donationId } = req.body;
      if (!donationId) {
        res.status(400).json({ error: "Missing donationId" });
        return;
      }

      const donationRef = db.collection("donations").doc(donationId);
      const donationSnap = await donationRef.get();

      if (!donationSnap.exists) {
        res.status(404).json({ error: "Donation not found" });
        return;
      }

      const donation = donationSnap.data();
      if (!donation) {
        res.status(404).json({ error: "Donation not found" });
        return;
      }
      const orphanageId = donation.orphanageId;

      // Fetch orphanage subaccount
      const orphanageSnap = await db
        .collection("orphanages")
        .doc(orphanageId)
        .get();
      const orphanage = orphanageSnap.data();
      const subaccountCode = orphanage?.subaccountCode;

      if (!subaccountCode) {
        res.status(400).json({ error: "Orphanage missing subaccountCode" });
        return;
      }

      // Attempt split again
      let splitStatus: "success" | "failed" = "failed";
      let splitError: string | null = null;

      const PAYSTACK_URI =
        process.env.PAYSTACK_URI || "https://api.paystack.co";

      try {
        const splitResponse = await fetch(`${PAYSTACK_URI}/transaction/split`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paystackSecret.value()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            transaction: donation.paystackRef,
            subaccount: subaccountCode,
            share: donation.orphanagePayout,
          }),
        });

        const splitData = await splitResponse.json();
        if (splitData.status) {
          splitStatus = "success";
        } else {
          splitError = splitData.message || "Unknown split failure";
        }
      } catch (err: any) {
        splitError = err.message || "Split retry error";
      }

      // Update donation
      await donationRef.update({
        splitStatus,
        splitError,
        splitAttemptedAt: new Date(),
      });

      if (splitStatus === "failed") {
        // Send admin email (same pattern as earlier)
        // ... (reuse the email block from webhook)
      }

      res.json({ success: true, splitStatus, splitError });
      return;
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Internal error" });
      return;
    }
  }
);
