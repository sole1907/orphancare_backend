// Tests for registerDonor.ts

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

// Mock Brevo
const mockSendTransacEmail = jest.fn().mockResolvedValue({});
jest.mock('sib-api-v3-sdk', () => ({
  ApiClient: {
    instance: {
      authentications: {
        'api-key': { apiKey: '' },
      },
    },
  },
  TransactionalEmailsApi: jest.fn().mockImplementation(() => ({
    sendTransacEmail: mockSendTransacEmail,
  })),
}));

// Mock encryption
const mockEncryptPII = jest.fn();
const mockCreateBlindIndex = jest.fn();
const mockEncryptDeterministic = jest.fn();
jest.mock('../../functions/src/lib/encryption', () => ({
  encryptPII: mockEncryptPII,
  createBlindIndex: mockCreateBlindIndex,
  encryptDeterministic: mockEncryptDeterministic,
  PIIFieldType: {
    NAME: 'name',
    EMAIL: 'email',
    PHONE: 'phone',
  },
}));

import {
  mockFirestore,
  mockCollectionRef,
  mockDocRef,
  mockAuth,
} from '../setup/firebaseMocks';
import { createMockRequest, createMockResponse } from '../setup/testHelpers';
import { registerDonor } from '../../functions/src/registerDonor';

describe('registerDonor', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset Brevo mock
    mockSendTransacEmail.mockReset();
    mockSendTransacEmail.mockResolvedValue({});

    // Default mock implementations
    mockEncryptPII.mockImplementation((value, type) => ({
      ciphertext: `encrypted-${type}-${value}`,
      iv: 'test-iv',
      version: 1,
      keyId: 'dev-key',
    }));
    mockCreateBlindIndex.mockReturnValue('blind-index-hash');
    mockEncryptDeterministic.mockReturnValue('deterministic-hash');

    // Mock auth to throw "user not found" then create user
    mockAuth.getUserByEmail.mockRejectedValue(new Error('User not found'));
    mockAuth.createUser.mockResolvedValue({ uid: 'new-user-id', email: 'test@example.com' });
    mockAuth.setCustomUserClaims.mockResolvedValue(undefined);
    mockAuth.generateEmailVerificationLink.mockResolvedValue('https://verify.link');

    // Mock Firestore
    mockDocRef.set.mockResolvedValue(undefined);
  });

  describe('validation', () => {
    it('should reject request without email', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { password: 'password123' },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Missing email or password');
    });

    it('should reject request without password', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { email: 'test@example.com' },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Missing email or password');
    });
  });

  describe('user creation', () => {
    it('should create new user when user does not exist', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'new@example.com',
          password: 'password123',
          name: 'Test Donor',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockAuth.createUser).toHaveBeenCalledWith({
        email: 'new@example.com',
        password: 'password123',
        displayName: 'Test Donor',
      });
      expect(res.statusCode).toBe(200);
    });

    it('should reject registration when email already exists', async () => {
      mockAuth.getUserByEmail.mockResolvedValue({ uid: 'existing-user-id', email: 'existing@example.com' });

      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'existing@example.com',
          password: 'password123',
          name: 'Test Donor',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockAuth.createUser).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(409);
      expect(res._getData()).toContain('An account with this email already exists');
    });

    it('should set donor custom claim', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('new-user-id', { donor: true });
    });
  });

  describe('PII encryption', () => {
    it('should encrypt name, email, and phone', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Donor',
          phone: '+2341234567890',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockEncryptPII).toHaveBeenCalledWith('Test Donor', 'name');
      expect(mockEncryptPII).toHaveBeenCalledWith('test@example.com', 'email');
      expect(mockEncryptPII).toHaveBeenCalledWith('+2341234567890', 'phone');
    });

    it('should create blind index for email', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockCreateBlindIndex).toHaveBeenCalledWith('test@example.com');
    });

    it('should create deterministic hash for phone', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
          phone: '+2341234567890',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockEncryptDeterministic).toHaveBeenCalledWith('+2341234567890');
    });

    it('should handle missing optional PII fields', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      // encryptPII is called for name (null), email, and phone (null) via Promise.all
      // The function calls encryptPII for all three but name/phone return null when value is falsy
      expect(mockEncryptPII).toHaveBeenCalledWith('test@example.com', 'email');
      expect(mockEncryptDeterministic).not.toHaveBeenCalled();
    });
  });

  describe('donor record storage', () => {
    it('should store encrypted donor data in Firestore', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Donor',
          phone: '+2341234567890',
          country: 'Nigeria',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockFirestore.collection).toHaveBeenCalledWith('donors');
      expect(mockCollectionRef.doc).toHaveBeenCalledWith('new-user-id');
      expect(mockDocRef.set).toHaveBeenCalledWith(
        expect.objectContaining({
          name_encrypted: expect.objectContaining({ ciphertext: expect.any(String) }),
          email_encrypted: expect.objectContaining({ ciphertext: expect.any(String) }),
          email_blind_index: 'blind-index-hash',
          country: 'Nigeria',
          status: 'inactive',
          pushNotificationsEnabled: true,
        })
      );
    });

    it('should store optional birthday fields', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
          donorBirthdayMonth: 6,
          donorBirthdayDay: 15,
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockDocRef.set).toHaveBeenCalledWith(
        expect.objectContaining({
          donorBirthdayMonth: 6,
          donorBirthdayDay: 15,
        })
      );
    });

    it('should store donor hobbies as array', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
          donorHobbies: ['reading', 'music', 'sports'],
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockDocRef.set).toHaveBeenCalledWith(
        expect.objectContaining({
          donorHobbies: ['reading', 'music', 'sports'],
        })
      );
    });

    it('should not store non-array donorHobbies', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
          donorHobbies: 'not-an-array',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      const setCall = mockDocRef.set.mock.calls[0][0];
      expect(setCall.donorHobbies).toBeUndefined();
    });
  });

  describe('email verification', () => {
    it('should generate verification link', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockAuth.generateEmailVerificationLink).toHaveBeenCalledWith(
        'test@example.com',
        expect.objectContaining({
          handleCodeInApp: true,
        })
      );
      // Verify the URL contains the encoded email
      const callArgs = mockAuth.generateEmailVerificationLink.mock.calls[0][1];
      expect(callArgs.url).toContain('uid=new-user-id');
    });

    it('should send verification email via Brevo', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Donor',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockSendTransacEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: [{ email: 'test@example.com' }],
          subject: 'Verify your donor account',
          htmlContent: expect.stringContaining('Verify Email'),
        })
      );
    });

    it('should include donor name in email', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
          name: 'John Doe',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(mockSendTransacEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          htmlContent: expect.stringContaining('John Doe'),
        })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 on auth error', async () => {
      mockAuth.getUserByEmail.mockRejectedValue(new Error('User not found'));
      mockAuth.createUser.mockRejectedValue(new Error('Auth service unavailable'));

      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getData()).toContain('Internal error');
    });

    it('should return 500 on Firestore error', async () => {
      mockDocRef.set.mockRejectedValue(new Error('Firestore error'));

      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(res.statusCode).toBe(500);
    });

    it('should return 500 on email sending error', async () => {
      mockSendTransacEmail.mockRejectedValue(new Error('Email service error'));

      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(res.statusCode).toBe(500);
    });
  });

  describe('CORS handling', () => {
    it('should handle OPTIONS preflight request', async () => {
      const req = createMockRequest({
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.orphancare.org',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      // CORS handler should return early for OPTIONS
      expect(res.statusCode).toBe(204);
    });
  });

  describe('success response', () => {
    it('should return success message on successful registration', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
          name: 'Test Donor',
        },
      });
      const res = createMockResponse();

      await registerDonor(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getData()).toContain('Donor registered, verification email sent');
    });
  });
});
