import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import fs from "fs";

// Initialize Firebase Admin SDK
initializeApp({
  credential: applicationDefault(),
});

const users = JSON.parse(fs.readFileSync("bootstrapUsers.json", "utf-8"));

async function bootstrapUsers() {
  for (const user of users) {
    try {
      const createdUser = await getAuth().createUser({
        email: user.email,
        password: user.password,
      });

      const claims: Record<string, boolean> = {
        superAdmin: user.role === "superAdmin",
        orphanageAdmin: user.role === "orphanageAdmin",
        donor: user.role === "donor",
      };

      await getAuth().setCustomUserClaims(createdUser.uid, claims);
      console.log(`✅ Created ${user.role}: ${user.email}`);
    } catch (error: any) {
      if (error.code === "auth/email-already-exists") {
        console.log(`⚠️ User already exists: ${user.email}`);
      } else {
        console.error(`❌ Error creating ${user.email}:`, error.message);
      }
    }
  }
}

bootstrapUsers();
