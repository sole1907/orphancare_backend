"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendUpdateNotification = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const firebaseAdmin_1 = require("./lib/firebaseAdmin");
exports.sendUpdateNotification = (0, firestore_1.onDocumentCreated)({
    region: "europe-west1",
    document: "updates/{updateId}",
}, async (event) => {
    const update = event.data?.data();
    if (!update)
        return;
    const message = {
        notification: {
            title: update.title,
            body: update.body.slice(0, 100) + "...",
        },
        topic: "donors",
    };
    await firebaseAdmin_1.messaging.send(message);
});
