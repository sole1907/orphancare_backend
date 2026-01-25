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
const logger = __importStar(require("firebase-functions/logger"));
const firebaseAdmin_1 = require("./lib/firebaseAdmin");
const sib_api_v3_sdk_1 = __importDefault(require("sib-api-v3-sdk"));
const params_1 = require("firebase-functions/params");
const authUtils_1 = require("./lib/authUtils");
const corsUtils_1 = require("./lib/corsUtils");
const constants_1 = require("./config/constants");
const brevoApiKey = (0, params_1.defineSecret)("BREVO_API_KEY");
exports.inviteOrphanageAdmin = (0, https_1.onRequest)({ region: "europe-west1", secrets: [brevoApiKey] }, async (req, res) => {
    logger.info("Incoming headers:\n" + JSON.stringify(req.headers, null, 2));
    if ((0, corsUtils_1.handleCors)(req, res, constants_1.allowedOrigins))
        return;
    try {
        logger.info("inviteOrphanageAdmin triggered");
        // 🔐 Auth check
        try {
            const decoded = await (0, authUtils_1.verifyAuth)(req, {
                requiredRoles: ["superAdmin"],
            });
            logger.info(`Invite triggered by ${decoded.uid}`); // ... rest of your logic
        }
        catch (err) {
            logger.error("Auth error", err);
            res.status(err.code || 500).send(err.message || "Internal error");
            return;
        }
        const { email, orphanageId } = req.body;
        if (!email || !orphanageId) {
            res.status(400).send("Missing email or orphanageId");
            logger.error("Missing email or orphanageId");
            return;
        }
        let user;
        try {
            user = await firebaseAdmin_1.auth.getUserByEmail(email);
        }
        catch {
            user = await firebaseAdmin_1.auth.createUser({ email });
        }
        await firebaseAdmin_1.auth.setCustomUserClaims(user.uid, {
            orphanageAdmin: true,
            orphanageId,
        });
        // Write the orphanage admin UID into the orphanage doc
        await firebaseAdmin_1.db.doc(`orphanages/${orphanageId}`).update({
            adminUid: user.uid,
        });
        const actionCodeSettings = {
            url: `${process.env.REGISTRATION_REDIRECT_URL ||
                "https://localhost:3000/complete-registration"}?email=${encodeURIComponent(email)}&orphanageId=${orphanageId}`,
            handleCodeInApp: true,
        };
        const link = await firebaseAdmin_1.auth.generateSignInWithEmailLink(email, actionCodeSettings);
        const client = sib_api_v3_sdk_1.default.ApiClient.instance;
        client.authentications["api-key"].apiKey = brevoApiKey.value();
        const apiInstance = new sib_api_v3_sdk_1.default.TransactionalEmailsApi();
        await apiInstance.sendTransacEmail({
            sender: {
                email: `${process.env.SENDER_EMAIL || "sola.akanmu@gmail.com"}`,
                name: `${process.env.SENDER_NAME || "Sola"}`,
            },
            to: [{ email }],
            subject: "Complete your Orphanage Admin registration",
            htmlContent: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; background-color: #f9f9f9; border-radius: 8px;">
            <h2 style="color: #1e3a8a;">Welcome to Orphancare</h2>
            <p>Hello,</p>
            <p>You’ve been invited to manage your orphanage on <strong>Orphancare</strong>.</p>
            <p>Please click the button below to complete your registration and set your password:</p>
            <a href="${link}" style="display: inline-block; padding: 12px 24px; background-color: #1e3a8a; color: white; text-decoration: none; border-radius: 4px; margin-top: 12px;">Complete Registration</a>
            <p style="margin-top: 24px; font-size: 12px; color: #555;">If you have any questions, contact us at support@orphancare.org</p>
          </div>
        `,
        });
        logger.info(`Invite sent to ${email}`);
        res.status(200).send("Invite sent");
    }
    catch (error) {
        logger.error("Invite error", error);
        res.status(500).send("Internal error");
    }
});
