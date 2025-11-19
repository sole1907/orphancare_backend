import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getMessaging } from "firebase-admin/messaging";
import "./firebaseAdmin";

export const sendUpdateNotification = onDocumentCreated(
  {
    region: "europe-west1", // 👈 match your Firestore region
    document: "updates/{updateId}",
  },
  async (event) => {
    const update = event.data?.data();
    if (!update) return;

    const message = {
      notification: {
        title: update.title,
        body: update.body.slice(0, 100) + "...",
      },
      topic: "donors",
    };

    await getMessaging().send(message);
  }
);
