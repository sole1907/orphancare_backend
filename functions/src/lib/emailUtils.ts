// functions/src/lib/emailUtils.ts
import Brevo from "sib-api-v3-sdk";
import * as logger from "firebase-functions/logger";

// Logo URL - Upload your logo to Firebase Storage or hosting and update this URL
// For Firebase Storage: https://firebasestorage.googleapis.com/v0/b/YOUR_BUCKET/o/benevovia_logo.png?alt=media
// For Firebase Hosting: https://YOUR_PROJECT.web.app/assets/benevovia_logo.png
export const BENEVOVIA_LOGO_URL =
  process.env.BENEVOVIA_LOGO_URL ||
  "https://firebasestorage.googleapis.com/v0/b/orphancare-93b41.firebasestorage.app/o/benevovia_icon_wordmark.png?alt=media&token=a9b39c1d-675c-4557-84e8-2a39b207c9c9";

export const SENDER_EMAIL = process.env.SENDER_EMAIL || "sola.akanmu@gmail.com";
export const SENDER_NAME = process.env.SENDER_NAME || "Benevovia";

/**
 * Generate the email header with the Benevovia logo
 */
export function getEmailHeader(): string {
  return `
    <div style="text-align: center; margin-bottom: 24px;">
      <img src="${BENEVOVIA_LOGO_URL}" alt="Benevovia" style="max-width: 200px; height: auto;" />
    </div>
  `;
}

/**
 * Generate the email footer
 */
export function getEmailFooter(): string {
  return `
    <p style="margin-top: 24px; font-size: 12px; color: #555;">
      If you have any questions, contact us at support@benevovia.com
    </p>
  `;
}

/**
 * Generate cancellation instructions for recurring donations
 */
export function getCancellationInfo(): string {
  return `
    <div style="margin-top: 20px; padding: 16px; background-color: #f5f5f5; border-radius: 8px; font-size: 13px; color: #666;">
      <p style="margin: 0 0 8px 0;"><strong>Managing Your Recurring Donation</strong></p>
      <p style="margin: 0;">
        You can view, modify, or cancel your recurring donations anytime in the Benevovia app.
        If you have any questions or need assistance, please contact us at support@benevovia.com
      </p>
    </div>
  `;
}

/**
 * Wrap email content with consistent Benevovia styling
 */
export function wrapEmailContent(bodyContent: string): string {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; background-color: #f9f9f9; border-radius: 8px;">
      ${getEmailHeader()}
      ${bodyContent}
      ${getEmailFooter()}
    </div>
  `;
}

/**
 * Format currency for Nigerian Naira
 */
export function formatNGN(amount: number): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
  }).format(amount);
}

/**
 * Format date for Nigerian locale
 */
export function formatDateNG(date: Date): string {
  return date.toLocaleDateString("en-NG", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Get interval display text
 */
export function getIntervalText(interval: string): string {
  const intervalMap: Record<string, string> = {
    daily: "Daily",
    monthly: "Monthly",
    quarterly: "Quarterly",
    yearly: "Yearly",
  };
  return intervalMap[interval?.toLowerCase()] || interval || "Monthly";
}

interface SendEmailParams {
  to: string;
  subject: string;
  htmlContent: string;
  brevoApiKey: string;
}

/**
 * Send an email via Brevo
 */
export async function sendEmail({
  to,
  subject,
  htmlContent,
  brevoApiKey,
}: SendEmailParams): Promise<void> {
  const client = Brevo.ApiClient.instance;
  client.authentications["api-key"].apiKey = brevoApiKey;
  const apiInstance = new Brevo.TransactionalEmailsApi();

  await apiInstance.sendTransacEmail({
    sender: {
      email: SENDER_EMAIL,
      name: SENDER_NAME,
    },
    to: [{ email: to }],
    subject,
    htmlContent,
  });

  logger.info(`Email sent to ${to}: ${subject}`);
}

interface DonationThankYouParams {
  donorEmail: string;
  donorName?: string;
  childName: string;
  orphanageName: string;
  amount: number;
  isRecurring: boolean;
  interval?: string;
  nextChargeDate?: Date;
  brevoApiKey: string;
}

/**
 * Send a thank you email after a successful donation
 */
export async function sendDonationThankYouEmail({
  donorEmail,
  donorName,
  childName,
  orphanageName,
  amount,
  isRecurring,
  interval,
  nextChargeDate,
  brevoApiKey,
}: DonationThankYouParams): Promise<void> {
  const formattedAmount = formatNGN(amount);
  const greeting = donorName ? `Hello ${donorName},` : "Hello,";

  let bodyContent: string;

  if (isRecurring) {
    const intervalText = getIntervalText(interval || "monthly");
    const nextDateText = nextChargeDate
      ? formatDateNG(nextChargeDate)
      : "as scheduled";

    bodyContent = `
      <p>${greeting}</p>
      <p>Thank you for your generous recurring donation to support <strong>${childName}</strong> at <strong>${orphanageName}</strong>!</p>
      <div style="background-color: #e8f0fe; padding: 16px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0; font-size: 18px; color: #1e3a8a;">
          <strong>Amount:</strong> ${formattedAmount}
        </p>
        <p style="margin: 8px 0 0 0; color: #555;">
          <strong>Frequency:</strong> ${intervalText}
        </p>
        <p style="margin: 8px 0 0 0; color: #555;">
          <strong>Next donation:</strong> ${nextDateText}
        </p>
      </div>
      <p>Your continued support makes a real difference in the life of a child in need. We are deeply grateful for your commitment.</p>
      ${getCancellationInfo()}
    `;
  } else {
    bodyContent = `
      <p>${greeting}</p>
      <p>Thank you for your generous donation to support <strong>${childName}</strong> at <strong>${orphanageName}</strong>!</p>
      <div style="background-color: #e8f0fe; padding: 16px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 0; font-size: 18px; color: #1e3a8a;">
          <strong>Amount:</strong> ${formattedAmount}
        </p>
      </div>
      <p>Your generosity makes a real difference in the life of a child in need. Thank you for being part of our community.</p>
    `;
  }

  const htmlContent = wrapEmailContent(bodyContent);
  const subject = isRecurring
    ? "Thank You for Your Recurring Donation!"
    : "Thank You for Your Donation!";

  await sendEmail({
    to: donorEmail,
    subject,
    htmlContent,
    brevoApiKey,
  });
}

interface RecurringChargeConfirmationParams {
  donorEmail: string;
  donorName?: string;
  childName: string;
  orphanageName: string;
  amount: number;
  interval: string;
  nextChargeDate: Date;
  brevoApiKey: string;
}

/**
 * Send a confirmation email after a recurring donation is charged
 */
export async function sendRecurringChargeConfirmationEmail({
  donorEmail,
  donorName,
  childName,
  orphanageName,
  amount,
  interval,
  nextChargeDate,
  brevoApiKey,
}: RecurringChargeConfirmationParams): Promise<void> {
  const formattedAmount = formatNGN(amount);
  const intervalText = getIntervalText(interval);
  const nextDateText = formatDateNG(nextChargeDate);
  const greeting = donorName ? `Hello ${donorName},` : "Hello,";

  const bodyContent = `
    <p>${greeting}</p>
    <p>Your ${intervalText.toLowerCase()} donation to support <strong>${childName}</strong> at <strong>${orphanageName}</strong> has been successfully processed.</p>
    <div style="background-color: #e8f0fe; padding: 16px; border-radius: 8px; margin: 20px 0;">
      <p style="margin: 0; font-size: 18px; color: #1e3a8a;">
        <strong>Amount charged:</strong> ${formattedAmount}
      </p>
      <p style="margin: 8px 0 0 0; color: #555;">
        <strong>Frequency:</strong> ${intervalText}
      </p>
      <p style="margin: 8px 0 0 0; color: #555;">
        <strong>Next donation:</strong> ${nextDateText}
      </p>
    </div>
    <p>Thank you for your continued support! Your generosity helps provide care, education, and hope to children in need.</p>
    ${getCancellationInfo()}
  `;

  const htmlContent = wrapEmailContent(bodyContent);

  await sendEmail({
    to: donorEmail,
    subject: "Your Recurring Donation Was Processed",
    htmlContent,
    brevoApiKey,
  });
}
