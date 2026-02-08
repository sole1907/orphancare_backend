// Tests for initiateDonation.ts

// Mock dependencies before importing
jest.mock('firebase-functions/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn((options, handler) => handler),
}));

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

import {
  mockFirestore,
  mockCollectionRef,
  mockDocRef,
  createMockDocSnapshot,
  createMockQuerySnapshot,
  mockAuth,
} from '../setup/firebaseMocks';
import {
  createMockRequest,
  createMockResponse,
  createAuthenticatedRequest,
  createPreflightRequest,
} from '../setup/testHelpers';

// Import after mocking
import { initiateDonation } from '../../functions/src/initiateDonation';

describe('initiateDonation', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default auth mock
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'test-donor-id',
      email: 'donor@example.com',
    });

    // Default fee config mock
    mockCollectionRef.doc.mockImplementation((id: string) => {
      if (id === 'fees') {
        return {
          get: jest.fn().mockResolvedValue(
            createMockDocSnapshot(true, {
              percentage: 0.015,
              flatFee: 100,
              cap: 2000,
              vatPercentage: 0.075,
              flatFeeWaiverThreshold: 2500,
            })
          ),
        };
      }
      return mockDocRef;
    });

    // Default Paystack mock
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            status: true,
            data: {
              authorization_url: 'https://checkout.paystack.com/test',
              reference: 'ref_123',
            },
          })
        ),
    });
  });

  describe('CORS handling', () => {
    it('should handle OPTIONS preflight request', async () => {
      const req = createPreflightRequest('https://orphancare-93b41.web.app');
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(204);
    });
  });

  describe('authentication', () => {
    it('should reject request without auth token', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          donorUid: 'test-donor-id',
          donorEmail: 'donor@example.com',
          childId: 'child-1',
          orphanageId: 'orphanage-1',
          baseAmount: 5000,
          tipPercent: 0.1,
        },
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(401);
    });

    it('should reject request with mismatched UID', async () => {
      mockAuth.verifyIdToken.mockResolvedValue({
        uid: 'different-user-id',
        email: 'other@example.com',
      });

      const req = createAuthenticatedRequest(
        {
          donorUid: 'test-donor-id',
          donorEmail: 'donor@example.com',
          childId: 'child-1',
          orphanageId: 'orphanage-1',
          baseAmount: 5000,
          tipPercent: 0.1,
        },
        'different-user-id'
      );
      req.headers.origin = 'https://orphancare-93b41.web.app';
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getData()).toContain('UID mismatch');
    });
  });

  describe('validation', () => {
    it('should reject request with missing required fields', async () => {
      const req = createAuthenticatedRequest(
        {
          donorUid: 'test-donor-id',
          // Missing other required fields
        },
        'test-donor-id'
      );
      req.headers.origin = 'https://orphancare-93b41.web.app';
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Missing required fields');
    });

    it('should reject recurring donation with invalid interval', async () => {
      const orphanageDocMock = {
        get: jest.fn().mockResolvedValue(
          createMockDocSnapshot(true, { subaccountCode: 'ACCT_test123' })
        ),
      };
      mockCollectionRef.doc.mockImplementation((id: string) => {
        if (id === 'fees') {
          return {
            get: jest.fn().mockResolvedValue(
              createMockDocSnapshot(true, {
                percentage: 0.015,
                flatFee: 100,
                cap: 2000,
                vatPercentage: 0.075,
                flatFeeWaiverThreshold: 2500,
              })
            ),
          };
        }
        if (id === 'orphanage-1') {
          return orphanageDocMock;
        }
        return mockDocRef;
      });

      const req = createAuthenticatedRequest(
        {
          donorUid: 'test-donor-id',
          donorEmail: 'donor@example.com',
          childId: 'child-1',
          orphanageId: 'orphanage-1',
          baseAmount: 5000,
          tipPercent: 0.1,
          recurring: true,
          interval: 'weekly', // Invalid interval
        },
        'test-donor-id'
      );
      req.headers.origin = 'https://orphancare-93b41.web.app';
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Invalid interval');
    });
  });

  describe('one-off donation', () => {
    beforeEach(() => {
      // Setup orphanage mock
      mockCollectionRef.doc.mockImplementation((id: string) => {
        if (id === 'fees') {
          return {
            get: jest.fn().mockResolvedValue(
              createMockDocSnapshot(true, {
                percentage: 0.015,
                flatFee: 100,
                cap: 2000,
                vatPercentage: 0.075,
                flatFeeWaiverThreshold: 2500,
              })
            ),
          };
        }
        if (id === 'orphanage-1') {
          return {
            get: jest.fn().mockResolvedValue(
              createMockDocSnapshot(true, { subaccountCode: 'ACCT_test123' })
            ),
          };
        }
        return mockDocRef;
      });

      // Mock empty pending donations query
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));
    });

    it('should return checkout URL for valid one-off donation', async () => {
      const req = createAuthenticatedRequest(
        {
          donorUid: 'test-donor-id',
          donorEmail: 'donor@example.com',
          childId: 'child-1',
          orphanageId: 'orphanage-1',
          baseAmount: 5000,
          tipPercent: 0.1,
          recurring: false,
        },
        'test-donor-id'
      );
      req.headers.origin = 'https://orphancare-93b41.web.app';
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.checkoutUrl).toBe('https://checkout.paystack.com/test');
    });

    it('should reject donation for orphanage without subaccount', async () => {
      mockCollectionRef.doc.mockImplementation((id: string) => {
        if (id === 'fees') {
          return {
            get: jest.fn().mockResolvedValue(
              createMockDocSnapshot(true, {
                percentage: 0.015,
                flatFee: 100,
                cap: 2000,
                vatPercentage: 0.075,
                flatFeeWaiverThreshold: 2500,
              })
            ),
          };
        }
        if (id === 'orphanage-1') {
          return {
            get: jest.fn().mockResolvedValue(
              createMockDocSnapshot(true, {}) // No subaccountCode
            ),
          };
        }
        return mockDocRef;
      });

      const req = createAuthenticatedRequest(
        {
          donorUid: 'test-donor-id',
          donorEmail: 'donor@example.com',
          childId: 'child-1',
          orphanageId: 'orphanage-1',
          baseAmount: 5000,
          tipPercent: 0.1,
          recurring: false,
        },
        'test-donor-id'
      );
      req.headers.origin = 'https://orphancare-93b41.web.app';
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('no subaccount configured');
    });

    it('should reject donation for invalid orphanage', async () => {
      mockCollectionRef.doc.mockImplementation((id: string) => {
        if (id === 'fees') {
          return {
            get: jest.fn().mockResolvedValue(
              createMockDocSnapshot(true, {
                percentage: 0.015,
                flatFee: 100,
                cap: 2000,
                vatPercentage: 0.075,
                flatFeeWaiverThreshold: 2500,
              })
            ),
          };
        }
        if (id === 'orphanage-1') {
          return {
            get: jest.fn().mockResolvedValue(createMockDocSnapshot(false)),
          };
        }
        return mockDocRef;
      });

      const req = createAuthenticatedRequest(
        {
          donorUid: 'test-donor-id',
          donorEmail: 'donor@example.com',
          childId: 'child-1',
          orphanageId: 'orphanage-1',
          baseAmount: 5000,
          tipPercent: 0.1,
          recurring: false,
        },
        'test-donor-id'
      );
      req.headers.origin = 'https://orphancare-93b41.web.app';
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Invalid orphanage');
    });
  });

  describe('recurring donation', () => {
    beforeEach(() => {
      mockCollectionRef.doc.mockImplementation((id: string) => {
        if (id === 'fees') {
          return {
            get: jest.fn().mockResolvedValue(
              createMockDocSnapshot(true, {
                percentage: 0.015,
                flatFee: 100,
                cap: 2000,
                vatPercentage: 0.075,
                flatFeeWaiverThreshold: 2500,
              })
            ),
            set: jest.fn().mockResolvedValue(undefined),
          };
        }
        if (id === 'orphanage-1') {
          return {
            get: jest.fn().mockResolvedValue(
              createMockDocSnapshot(true, { subaccountCode: 'ACCT_test123' })
            ),
          };
        }
        return {
          ...mockDocRef,
          set: jest.fn().mockResolvedValue(undefined),
        };
      });

      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));
    });

    it('should return checkout URL and planCode for recurring donation', async () => {
      const req = createAuthenticatedRequest(
        {
          donorUid: 'test-donor-id',
          donorEmail: 'donor@example.com',
          childId: 'child-1',
          orphanageId: 'orphanage-1',
          baseAmount: 5000,
          tipPercent: 0.1,
          recurring: true,
          interval: 'monthly',
        },
        'test-donor-id'
      );
      req.headers.origin = 'https://orphancare-93b41.web.app';
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.checkoutUrl).toBe('https://checkout.paystack.com/test');
      expect(data.planCode).toBeDefined();
      expect(data.planCode).toMatch(/^RC_/);
    });

    it('should allow daily interval in non-production', async () => {
      process.env.ENV_TYPE = 'development';

      const req = createAuthenticatedRequest(
        {
          donorUid: 'test-donor-id',
          donorEmail: 'donor@example.com',
          childId: 'child-1',
          orphanageId: 'orphanage-1',
          baseAmount: 5000,
          tipPercent: 0.1,
          recurring: true,
          interval: 'daily',
        },
        'test-donor-id'
      );
      req.headers.origin = 'https://orphancare-93b41.web.app';
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 on Paystack initialization failure', async () => {
      mockCollectionRef.doc.mockImplementation((id: string) => {
        if (id === 'fees') {
          return {
            get: jest.fn().mockResolvedValue(
              createMockDocSnapshot(true, {
                percentage: 0.015,
                flatFee: 100,
                cap: 2000,
                vatPercentage: 0.075,
                flatFeeWaiverThreshold: 2500,
              })
            ),
          };
        }
        if (id === 'orphanage-1') {
          return {
            get: jest.fn().mockResolvedValue(
              createMockDocSnapshot(true, { subaccountCode: 'ACCT_test123' })
            ),
          };
        }
        return mockDocRef;
      });
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({ status: false, message: 'Invalid email' })
          ),
      });

      const req = createAuthenticatedRequest(
        {
          donorUid: 'test-donor-id',
          donorEmail: 'invalid-email',
          childId: 'child-1',
          orphanageId: 'orphanage-1',
          baseAmount: 5000,
          tipPercent: 0.1,
          recurring: false,
        },
        'test-donor-id'
      );
      req.headers.origin = 'https://orphancare-93b41.web.app';
      const res = createMockResponse();

      await initiateDonation(req, res);

      expect(res.statusCode).toBe(500);
    });
  });
});
