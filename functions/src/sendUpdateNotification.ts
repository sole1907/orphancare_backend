import * as functions from "firebase-functions";
import { getMessaging } from "./firebaseAdmin";
import "./firebaseAdmin";

export const sendUpdateNotification = functions
  .region("europe-west1")
  .firestore.document("updates/{updateId}")
  .onCreate(async (snapshot, context) => {
    const update = snapshot.data();
    if (!update) return;

    const message = {
      notification: {
        title: update.title,
        body: update.body.slice(0, 100) + "...",
      },
      topic: "donors",
    };

    await getMessaging().send(message);
  });
