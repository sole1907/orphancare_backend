// Tests for approveOrphanageAccount.ts

jest.mock('firebase-functions/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn((options, handler) => handler),
}));

jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn(() => ({ value: () => 'sk_test_xxx' })),
}));

// Mock authUtils
const mockVerifyAuth = jest.fn();
jest.mock('../../functions/src/lib/authUtils', () => ({
  verifyAuth: mockVerifyAuth,
}));

// Mock encryption
const mockDecrypt = jest.fn();
const mockEncryptPII = jest.fn();
jest.mock('../../functions/src/lib/encryption', () => ({
  decrypt: mockDecrypt,
  encryptPII: mockEncryptPII,
  PIIFieldType: { SUBACCOUNT_CODE: 'subaccount_code' },
}));

// Mock audit logger
const mockAuditLogWithRequest = jest.fn().mockResolvedValue(undefined);
jest.mock('../../functions/src/lib/auditLogger', () => ({
  auditLogger: {
    logWithRequest: mockAuditLogWithRequest,
  },
  AuditAction: {
    APPROVE_BANK_ACCOUNT: 'approve_bank_account',
  },
  ResourceType: {
    ORPHANAGE: 'orphanage',
  },
}));

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

import {
  mockFirestore,
  mockCollectionRef,
  mockDocRef,
  createMockDocSnapshot,
} from '../setup/firebaseMocks';
import { createMockRequest, createMockResponse } from '../setup/testHelpers';
import { approveOrphanageAccount } from '../../functions/src/approveOrphanageAccount';

describe('approveOrphanageAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default auth success as superAdmin
    mockVerifyAuth.mockResolvedValue({
      uid: 'admin-123',
      email: 'admin@example.com',
      superAdmin: true,
    });

    // Default decryption
    mockDecrypt.mockResolvedValue('1234567890');
    mockEncryptPII.mockResolvedValue({
      ciphertext: 'encrypted-subaccount',
      iv: 'iv',
      version: 1,
    });

    // Default Paystack response
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          status: true,
          data: { subaccount_code: 'ACCT_test123' },
        }),
    });

    // Default Firestore doc
    mockDocRef.get.mockResolvedValue(
      createMockDocSnapshot(true, {
        name: 'Test Orphanage',
        bankCode: '058',
        accountNumberEncrypted: {
          ciphertext: 'encrypted-account',
          iv: 'iv',
        },
      })
    );
    mockDocRef.update.mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('should reject non-superAdmin users', async () => {
      mockVerifyAuth.mockRejectedValue({ code: 403, message: 'Forbidden' });

      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(res.statusCode).toBe(500);
    });

    it('should require superAdmin role', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(mockVerifyAuth).toHaveBeenCalledWith(req, {
        requiredRoles: ['superAdmin'],
      });
    });
  });

  describe('validation', () => {
    it('should reject request without orphanageId', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {},
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res._getData());
      expect(data.error).toContain('Missing orphanageId');
    });

    it('should return 404 for non-existent orphanage', async () => {
      mockDocRef.get.mockResolvedValue(createMockDocSnapshot(false, {}));

      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'nonexistent' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(res.statusCode).toBe(404);
    });

    it('should reject orphanage without encrypted account number', async () => {
      mockDocRef.get.mockResolvedValue(
        createMockDocSnapshot(true, {
          name: 'Test Orphanage',
          bankCode: '058',
          // No accountNumberEncrypted
        })
      );

      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res._getData());
      expect(data.error).toContain('Encrypted account number missing');
    });
  });

  describe('subaccount creation', () => {
    it('should create new subaccount when none exists', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/subaccount'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk_test_xxx',
          }),
        })
      );

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body).toMatchObject({
        business_name: 'Test Orphanage',
        settlement_bank: '058',
        account_number: '1234567890',
        percentage_charge: 0,
      });
    });

    it('should update existing subaccount', async () => {
      mockDocRef.get.mockResolvedValue(
        createMockDocSnapshot(true, {
          name: 'Test Orphanage',
          bankCode: '058',
          accountNumberEncrypted: { ciphertext: 'encrypted', iv: 'iv' },
          subaccountCode: 'ACCT_existing', // Has existing subaccount
        })
      );

      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/subaccount/ACCT_existing'),
        expect.objectContaining({ method: 'PUT' })
      );
    });
  });

  describe('Paystack error handling', () => {
    it('should return error when subaccount creation fails', async () => {
      mockFetch.mockResolvedValue({
        json: () =>
          Promise.resolve({
            status: false,
            message: 'Invalid bank account',
          }),
      });

      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(res.statusCode).toBe(400);
      const data = JSON.parse(res._getData());
      expect(data.error).toBe('Invalid bank account');
    });

    it('should return error when subaccount update fails', async () => {
      mockDocRef.get.mockResolvedValue(
        createMockDocSnapshot(true, {
          name: 'Test Orphanage',
          bankCode: '058',
          accountNumberEncrypted: { ciphertext: 'encrypted', iv: 'iv' },
          subaccountCode: 'ACCT_existing',
        })
      );

      mockFetch.mockResolvedValue({
        json: () =>
          Promise.resolve({
            status: false,
            message: 'Update failed',
          }),
      });

      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(res.statusCode).toBe(400);
    });
  });

  describe('Firestore update', () => {
    it('should encrypt and store subaccount code', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(mockEncryptPII).toHaveBeenCalledWith('ACCT_test123', 'subaccount_code');
      expect(mockDocRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          subaccountCode_encrypted: expect.objectContaining({
            ciphertext: 'encrypted-subaccount',
          }),
          subaccountCode: null, // Remove plain text
          accountVerificationStatus: 'approved',
          accountNumberEncrypted: null, // Remove sensitive data
        })
      );
    });
  });

  describe('audit logging', () => {
    it('should log successful approval', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(mockAuditLogWithRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'approve_bank_account',
          resourceType: 'orphanage',
          resourceId: 'orphanage-123',
          success: true,
        })
      );
    });
  });

  describe('success response', () => {
    it('should return success with subaccount code', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.success).toBe(true);
      expect(data.subaccountCode).toBe('ACCT_test123');
    });
  });

  describe('error handling', () => {
    it('should return 500 on internal error', async () => {
      mockDecrypt.mockRejectedValue(new Error('Decryption failed'));

      const req = createMockRequest({
        method: 'POST',
        body: { orphanageId: 'orphanage-123' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(res.statusCode).toBe(500);
    });
  });

  describe('CORS handling', () => {
    it('should handle OPTIONS preflight request', async () => {
      const req = createMockRequest({
        method: 'OPTIONS',
        headers: { origin: 'https://admin.orphancare.org' },
      });
      const res = createMockResponse();

      await approveOrphanageAccount(req, res);

      expect(res.statusCode).toBe(204);
    });
  });
});
