import { onRequest } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

const db = admin.firestore();

export const verifyDonor = onRequest(
  { region: "europe-west1" },
  async (req, res) => {
    const { uid } = req.query;
    if (!uid) {
      res.status(400).send("Missing uid");
      return;
    }

    try {
      await admin.auth().updateUser(uid as string, { emailVerified: true });
      await db
        .collection("donors")
        .doc(uid as string)
        .update({
          status: "active",
          verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.send(`
        <html>
          <body style="font-family:Arial;max-width:600px;margin:auto;padding:24px;">
            <h2>Your donor account is now activated ✅</h2>
            <p>You can now log in to the donor app.</p>
          </body>
        </html>
      `);
    } catch (err) {
      res.status(500).send("Verification failed");
    }
  }
);
