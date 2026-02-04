import { EncryptedField } from "../lib/encryption";

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
  subaccountCode_encrypted?: EncryptedField;
  subaccountCode?: string; // Legacy field for backward compatibility
  adminUid: string;
  // add any other fields you store in Firestore
}
