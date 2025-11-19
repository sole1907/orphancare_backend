"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMessaging = exports.getAuth = void 0;
// firebaseAdmin.ts
const app_1 = require("firebase-admin/app");
if (!(0, app_1.getApps)().length) {
    (0, app_1.initializeApp)();
}
var auth_1 = require("firebase-admin/auth");
Object.defineProperty(exports, "getAuth", { enumerable: true, get: function () { return auth_1.getAuth; } });
var messaging_1 = require("firebase-admin/messaging");
Object.defineProperty(exports, "getMessaging", { enumerable: true, get: function () { return messaging_1.getMessaging; } });
