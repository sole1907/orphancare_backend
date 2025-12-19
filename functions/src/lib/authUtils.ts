// authUtils.ts
import { auth } from "./firebaseAdmin";
import { Request } from "express";
import * as admin from "firebase-admin";

export interface AuthCheckOptions {
  requiredRoles?: string[]; // e.g. ["superAdmin"]
}

export async function verifyAuth(
  req: Request,
  options: AuthCheckOptions = {}
): Promise<admin.auth.DecodedIdToken> {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    throw { code: 401, message: "Unauthorized: Missing token" };
  }

  const idToken = authHeader.split("Bearer ")[1];
  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken);
  } catch {
    throw { code: 401, message: "Unauthorized: Invalid token" };
  }

  if (options.requiredRoles?.length) {
    const hasRole = options.requiredRoles.some((role) => decoded[role]);
    if (!hasRole) {
      throw {
        code: 403,
        message: `Forbidden: Requires one of roles [${options.requiredRoles.join(
          ", "
        )}]`,
      };
    }
  }

  return decoded;
}
