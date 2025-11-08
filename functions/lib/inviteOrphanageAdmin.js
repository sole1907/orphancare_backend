"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.inviteOrphanageAdmin = void 0;
const https_1 = require("firebase-functions/v2/https");
const app_1 = require("firebase-admin/app");
const auth_1 = require("firebase-admin/auth");
const logger = __importStar(require("firebase-functions/logger"));
const sib_api_v3_sdk_1 = __importDefault(require("sib-api-v3-sdk"));
(0, app_1.initializeApp)();
exports.inviteOrphanageAdmin = (0, https_1.onRequest)({ region: "europe-west1" }, async (req, res) => {
    try {
        const { email, orphanageId } = req.body;
        if (!email || !orphanageId) {
            res.status(400).send("Missing email or orphanageId");
            return;
        }
        const auth = (0, auth_1.getAuth)();
        // Ensure user exists or create them
        let user;
        try {
            user = await auth.getUserByEmail(email);
        }
        catch {
            user = await auth.createUser({ email });
        }
        // Set custom claims
        await auth.setCustomUserClaims(user.uid, {
            orphanageAdmin: true,
            orphanageId,
        });
        // Generate sign-in link
        const actionCodeSettings = {
            url: "https://hopebridge.vercel.app/complete-registration",
            handleCodeInApp: true,
        };
        const link = await auth.generateSignInWithEmailLink(email, actionCodeSettings);
        // Send email via Brevo
        const client = sib_api_v3_sdk_1.default.ApiClient.instance;
        client.authentications["api-key"].apiKey = process.env.FIREBASE_CONFIG
            ? JSON.parse(process.env.FIREBASE_CONFIG).brevo?.apikey
            : process.env.brevo_apikey;
        const apiInstance = new sib_api_v3_sdk_1.default.TransactionalEmailsApi();
        await apiInstance.sendTransacEmail({
            sender: { email: "noreply@hopebridge.org", name: "HopeBridge" },
            to: [{ email }],
            subject: "Complete your Orphanage Admin registration",
            htmlContent: `<p>Hello,</p><p>You’ve been invited to manage your orphanage on HopeBridge.</p><p><a href="${link}">Click here to complete your registration</a>.</p>`,
        });
        logger.info(`Invite sent to ${email}`);
        res.status(200).send("Invite sent");
    }
    catch (error) {
        logger.error("Invite error", error);
        res.status(500).send("Internal error");
    }
});
