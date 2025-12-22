export interface OrphanageData {
  name: string;
  bankName: string;
  bankCode: string;
  accountName: string;
  accountNumberMasked: string;
  accountVerificationStatus:
    | "none"
    | "otp_pending"
    | "pending"
    | "approved"
    | "rejected";
  subaccountCode?: string;
  adminUid: string;
  // add any other fields you store in Firestore
}
