// Tests for getDonorProfile.ts

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
  defineSecret: jest.fn(() => ({ value: () => 'mock-secret-value' })),
}));

// Mock authUtils
const mockVerifyAuth = jest.fn();
jest.mock('../../functions/src/lib/authUtils', () => ({
  verifyAuth: mockVerifyAuth,
}));

// Mock encryption
const mockDecryptPII = jest.fn();
jest.mock('../../functions/src/lib/encryption', () => ({
  decryptPII: mockDecryptPII,
}));

import {
  mockFirestore,
  mockCollectionRef,
  mockDocRef,
  createMockDocSnapshot,
} from '../setup/firebaseMocks';
import { createMockRequest, createMockResponse } from '../setup/testHelpers';
import { getDonorProfile } from '../../functions/src/getDonorProfile';

describe('getDonorProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default auth success
    mockVerifyAuth.mockResolvedValue({ uid: 'donor-123', email: 'donor@example.com' });

    // Default decryption
    mockDecryptPII.mockImplementation((encrypted) => {
      return Promise.resolve(`decrypted-${encrypted.ciphertext}`);
    });
  });

  describe('authentication', () => {
    it('should reject unauthenticated requests', async () => {
      mockVerifyAuth.mockRejectedValue({ code: 401, message: 'No token provided' });

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getData()).toContain('No token provided');
    });

    it('should reject expired tokens', async () => {
      mockVerifyAuth.mockRejectedValue({ code: 401, message: 'Token expired' });

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(res.statusCode).toBe(401);
    });
  });

  describe('donor lookup', () => {
    it('should return 404 when donor not found', async () => {
      mockDocRef.get.mockResolvedValue(createMockDocSnapshot(false, {}));

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(res.statusCode).toBe(404);
      expect(res._getData()).toContain('Donor not found');
    });

    it('should fetch donor by authenticated uid', async () => {
      mockVerifyAuth.mockResolvedValue({ uid: 'donor-123' });
      mockDocRef.get.mockResolvedValue(
        createMockDocSnapshot(true, {
          name_encrypted: { ciphertext: 'name', iv: 'iv', version: 1 },
          email_encrypted: { ciphertext: 'email', iv: 'iv', version: 1 },
          country: 'Nigeria',
          status: 'active',
        })
      );

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(mockFirestore.collection).toHaveBeenCalledWith('donors');
      expect(mockCollectionRef.doc).toHaveBeenCalledWith('donor-123');
    });
  });

  describe('PII decryption', () => {
    it('should decrypt encrypted PII fields', async () => {
      mockDocRef.get.mockResolvedValue(
        createMockDocSnapshot(true, {
          name_encrypted: { ciphertext: 'enc-name', iv: 'iv', version: 1 },
          email_encrypted: { ciphertext: 'enc-email', iv: 'iv', version: 1 },
          phone_encrypted: { ciphertext: 'enc-phone', iv: 'iv', version: 1 },
          country: 'Nigeria',
          status: 'active',
        })
      );

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(mockDecryptPII).toHaveBeenCalledTimes(3);
      expect(res.statusCode).toBe(200);

      const data = JSON.parse(res._getData()).data;
      expect(data.name).toBe('decrypted-enc-name');
      expect(data.email).toBe('decrypted-enc-email');
      expect(data.phone).toBe('decrypted-enc-phone');
    });

    it('should fall back to plaintext on decryption failure', async () => {
      mockDecryptPII.mockRejectedValue(new Error('Decryption failed'));

      mockDocRef.get.mockResolvedValue(
        createMockDocSnapshot(true, {
          name_encrypted: { ciphertext: 'enc-name', iv: 'iv', version: 1 },
          name: 'Plaintext Name',
          email_encrypted: { ciphertext: 'enc-email', iv: 'iv', version: 1 },
          email: 'plaintext@example.com',
          country: 'Nigeria',
          status: 'active',
        })
      );

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(res.statusCode).toBe(200);

      const data = JSON.parse(res._getData()).data;
      expect(data.name).toBe('Plaintext Name');
      expect(data.email).toBe('plaintext@example.com');
    });

    it('should use plaintext when no encrypted field exists', async () => {
      mockDocRef.get.mockResolvedValue(
        createMockDocSnapshot(true, {
          name: 'Legacy Name',
          email: 'legacy@example.com',
          phone: '+2341234567890',
          country: 'Nigeria',
          status: 'active',
        })
      );

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(mockDecryptPII).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);

      const data = JSON.parse(res._getData()).data;
      expect(data.name).toBe('Legacy Name');
      expect(data.email).toBe('legacy@example.com');
      expect(data.phone).toBe('+2341234567890');
    });
  });

  describe('response structure', () => {
    it('should return complete donor profile', async () => {
      mockVerifyAuth.mockResolvedValue({ uid: 'donor-123' });
      mockDocRef.get.mockResolvedValue(
        createMockDocSnapshot(true, {
          name_encrypted: { ciphertext: 'name', iv: 'iv', version: 1 },
          email_encrypted: { ciphertext: 'email', iv: 'iv', version: 1 },
          phone_encrypted: { ciphertext: 'phone', iv: 'iv', version: 1 },
          country: 'Nigeria',
          status: 'active',
          donorBirthdayMonth: 6,
          donorBirthdayDay: 15,
          donorHobbies: ['reading', 'music'],
          photoUrl: 'https://example.com/photo.jpg',
          pushNotificationsEnabled: false,
        })
      );

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(res.statusCode).toBe(200);

      const data = JSON.parse(res._getData()).data;
      expect(data).toMatchObject({
        uid: 'donor-123',
        country: 'Nigeria',
        status: 'active',
        donorBirthdayMonth: 6,
        donorBirthdayDay: 15,
        donorHobbies: ['reading', 'music'],
        photoUrl: 'https://example.com/photo.jpg',
        pushNotificationsEnabled: false,
      });
    });

    it('should provide default values for missing fields', async () => {
      mockDocRef.get.mockResolvedValue(
        createMockDocSnapshot(true, {
          email_encrypted: { ciphertext: 'email', iv: 'iv', version: 1 },
        })
      );

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(res.statusCode).toBe(200);

      const data = JSON.parse(res._getData()).data;
      expect(data.country).toBe('');
      expect(data.status).toBe('inactive');
      expect(data.donorBirthdayMonth).toBeNull();
      expect(data.donorBirthdayDay).toBeNull();
      expect(data.donorHobbies).toEqual([]);
      expect(data.photoUrl).toBeNull();
      expect(data.pushNotificationsEnabled).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 on Firestore error', async () => {
      mockDocRef.get.mockRejectedValue(new Error('Firestore error'));

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getData()).toContain('Internal error');
    });
  });

  describe('CORS handling', () => {
    it('should handle OPTIONS preflight request', async () => {
      const req = createMockRequest({
        method: 'OPTIONS',
        headers: { origin: 'https://app.orphancare.org' },
      });
      const res = createMockResponse();

      await getDonorProfile(req, res);

      expect(res.statusCode).toBe(204);
    });
  });
});
