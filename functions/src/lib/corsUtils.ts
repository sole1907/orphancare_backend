import * as logger from "firebase-functions/logger";
import type { Request, Response } from "express";

export function handleCors(
  req: Request,
  res: Response,
  allowedOrigins: string[]
): boolean {
  const origin = req.headers.origin as string | undefined;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Origin, Accept"
  );

  if (req.method === "OPTIONS") {
    logger.info(`Preflight request received from origin: ${origin}`);
    res.status(204).send("");
    return true;
  }

  return false;
}
