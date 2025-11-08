"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendUpdateNotification = void 0;
const firestore_1 = require("firebase-functions/v2/firestore");
const app_1 = require("firebase-admin/app");
const messaging_1 = require("firebase-admin/messaging");
(0, app_1.initializeApp)();
exports.sendUpdateNotification = (0, firestore_1.onDocumentCreated)({
    region: "europe-west1", // 👈 match your Firestore region
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
    await (0, messaging_1.getMessaging)().send(message);
});
