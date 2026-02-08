// Tests for chargeRecurringDonations.ts

// Mock dependencies before importing
jest.mock('firebase-functions/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Capture the handler function when onSchedule is called
let scheduledHandler: (() => Promise<void>) | null = null;

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: jest.fn((options, handler) => {
    scheduledHandler = handler;
    return handler;
  }),
}));

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

// Mock encryption module
const mockDecryptPII = jest.fn().mockResolvedValue('AUTH_decrypted_code');
jest.mock('../../functions/src/lib/encryption', () => ({
  decryptPII: mockDecryptPII,
}));

import {
  mockFirestore,
  mockCollectionRef,
  createMockDocSnapshot,
  createMockQuerySnapshot,
} from '../setup/firebaseMocks';
import { createTestRecurringPlan, createTestOrphanage } from '../setup/testHelpers';

// Import after mocking - this will register the handler
import '../../functions/src/chargeRecurringDonations';

describe('chargeRecurringDonations', () => {
  const now = new Date('2024-01-15T12:00:00Z');

  // Helper to run the scheduled function
  const runScheduledFunction = async () => {
    if (!scheduledHandler) {
      throw new Error('Scheduled handler not registered');
    }
    await scheduledHandler();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(now);

    // Default successful charge response
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            status: true,
            data: { reference: 'charge_ref_123', status: 'success' },
          })
        ),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('basic functionality', () => {
    it('should do nothing when no plans are due', async () => {
      mockFirestore.collection.mockReturnValue({
        ...mockCollectionRef,
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockResolvedValue(createMockQuerySnapshot([])),
      });

      await runScheduledFunction();

      // Should not have called fetch for any charges
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should process plans due for charge', async () => {
      const plan = createTestRecurringPlan({
        nextChargeAt: new Date('2024-01-14T00:00:00Z'), // Yesterday
        interval: 'monthly',
      });
      plan.authorizationCode_encrypted = {
        ciphertext: 'encrypted-auth-code',
        iv: 'test-iv',
        version: 1,
        keyId: 'dev-key',
      };

      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };

      // First call returns plans, second call returns empty (pagination complete)
      let callCount = 0;
      const mockRecurringCollection = {
        ...mockCollectionRef,
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        get: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve(
              createMockQuerySnapshot([
                { id: 'plan-1', data: plan, ref: mockPlanRef },
              ])
            );
          }
          return Promise.resolve(createMockQuerySnapshot([]));
        }),
      };

      const mockOrphanageDoc = {
        get: jest.fn().mockResolvedValue(
          createMockDocSnapshot(true, createTestOrphanage())
        ),
      };

      mockFirestore.collection.mockImplementation((name: string) => {
        if (name === 'recurringPlans') return mockRecurringCollection;
        if (name === 'orphanages') {
          return {
            ...mockCollectionRef,
            doc: jest.fn().mockReturnValue(mockOrphanageDoc),
          };
        }
        return mockCollectionRef;
      });

      await runScheduledFunction();

      // Should have called Paystack to charge the authorization
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/transaction/charge_authorization'),
        expect.any(Object)
      );

      // Should have updated the plan with new nextChargeAt
      expect(mockPlanRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          lastChargeAt: expect.any(Date),
          nextChargeAt: expect.any(Date),
          retryCount: 0,
        })
      );
    });

    it('should skip daily plans in production', async () => {
      process.env.ENV_TYPE = 'production';

      const plan = createTestRecurringPlan({
        interval: 'daily',
        nextChargeAt: new Date('2024-01-14T00:00:00Z'),
      });
      plan.authorizationCode_encrypted = {
        ciphertext: 'encrypted-auth-code',
        iv: 'test-iv',
        version: 1,
        keyId: 'dev-key',
      };

      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };

      let callCount = 0;
      mockFirestore.collection.mockImplementation((name: string) => {
        if (name === 'recurringPlans') {
          return {
            ...mockCollectionRef,
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve(
                  createMockQuerySnapshot([
                    { id: 'plan-1', data: plan, ref: mockPlanRef },
                  ])
                );
              }
              return Promise.resolve(createMockQuerySnapshot([]));
            }),
          };
        }
        return mockCollectionRef;
      });

      await runScheduledFunction();

      // Should NOT have called Paystack for daily plan in production
      expect(mockFetch).not.toHaveBeenCalled();

      process.env.ENV_TYPE = 'development';
    });

    it('should skip plans without encrypted authorization code', async () => {
      const plan = createTestRecurringPlan({
        nextChargeAt: new Date('2024-01-14T00:00:00Z'),
      });
      // No authorizationCode_encrypted - explicitly remove it
      delete plan.authorizationCode_encrypted;

      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };

      let callCount = 0;
      mockFirestore.collection.mockImplementation((name: string) => {
        if (name === 'recurringPlans') {
          return {
            ...mockCollectionRef,
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve(
                  createMockQuerySnapshot([
                    { id: 'plan-1', data: plan, ref: mockPlanRef },
                  ])
                );
              }
              return Promise.resolve(createMockQuerySnapshot([]));
            }),
          };
        }
        return mockCollectionRef;
      });

      await runScheduledFunction();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('orphanage validation', () => {
    it('should skip plans for orphanages without subaccount', async () => {
      const plan = createTestRecurringPlan({
        nextChargeAt: new Date('2024-01-14T00:00:00Z'),
      });
      plan.authorizationCode_encrypted = {
        ciphertext: 'encrypted-auth-code',
        iv: 'test-iv',
        version: 1,
        keyId: 'dev-key',
      };

      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };

      let callCount = 0;
      const mockOrphanageDoc = {
        get: jest.fn().mockResolvedValue(
          createMockDocSnapshot(true, {}) // No subaccountCode
        ),
      };

      mockFirestore.collection.mockImplementation((name: string) => {
        if (name === 'recurringPlans') {
          return {
            ...mockCollectionRef,
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve(
                  createMockQuerySnapshot([
                    { id: 'plan-1', data: plan, ref: mockPlanRef },
                  ])
                );
              }
              return Promise.resolve(createMockQuerySnapshot([]));
            }),
          };
        }
        if (name === 'orphanages') {
          return {
            ...mockCollectionRef,
            doc: jest.fn().mockReturnValue(mockOrphanageDoc),
          };
        }
        return mockCollectionRef;
      });

      await runScheduledFunction();

      // Should have updated plan with error
      expect(mockPlanRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          lastError: 'Orphanage has no subaccount configured',
        })
      );

      // Should NOT have called Paystack
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('error handling and retries', () => {
    it('should increment retry count on charge failure', async () => {
      const plan = createTestRecurringPlan({
        nextChargeAt: new Date('2024-01-14T00:00:00Z'),
        retryCount: 0,
      });
      plan.authorizationCode_encrypted = {
        ciphertext: 'encrypted-auth-code',
        iv: 'test-iv',
        version: 1,
        keyId: 'dev-key',
      };

      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };

      // Mock charge failure
      mockFetch.mockRejectedValue(new Error('Charge failed'));

      let callCount = 0;
      const mockOrphanageDoc = {
        get: jest.fn().mockResolvedValue(
          createMockDocSnapshot(true, createTestOrphanage())
        ),
      };

      mockFirestore.collection.mockImplementation((name: string) => {
        if (name === 'recurringPlans') {
          return {
            ...mockCollectionRef,
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve(
                  createMockQuerySnapshot([
                    { id: 'plan-1', data: plan, ref: mockPlanRef },
                  ])
                );
              }
              return Promise.resolve(createMockQuerySnapshot([]));
            }),
          };
        }
        if (name === 'orphanages') {
          return {
            ...mockCollectionRef,
            doc: jest.fn().mockReturnValue(mockOrphanageDoc),
          };
        }
        return mockCollectionRef;
      });

      await runScheduledFunction();

      expect(mockPlanRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          retryCount: 1,
          lastError: 'Charge failed',
        })
      );
    });

    it('should pause plan after max retries', async () => {
      const plan = createTestRecurringPlan({
        nextChargeAt: new Date('2024-01-14T00:00:00Z'),
        retryCount: 2, // Already tried twice
        maxRetries: 3,
      });
      plan.authorizationCode_encrypted = {
        ciphertext: 'encrypted-auth-code',
        iv: 'test-iv',
        version: 1,
        keyId: 'dev-key',
      };

      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };

      mockFetch.mockRejectedValue(new Error('Charge failed again'));

      let callCount = 0;
      const mockOrphanageDoc = {
        get: jest.fn().mockResolvedValue(
          createMockDocSnapshot(true, createTestOrphanage())
        ),
      };

      mockFirestore.collection.mockImplementation((name: string) => {
        if (name === 'recurringPlans') {
          return {
            ...mockCollectionRef,
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve(
                  createMockQuerySnapshot([
                    { id: 'plan-1', data: plan, ref: mockPlanRef },
                  ])
                );
              }
              return Promise.resolve(createMockQuerySnapshot([]));
            }),
          };
        }
        if (name === 'orphanages') {
          return {
            ...mockCollectionRef,
            doc: jest.fn().mockReturnValue(mockOrphanageDoc),
          };
        }
        return mockCollectionRef;
      });

      await runScheduledFunction();

      // Should pause the plan after max retries
      expect(mockPlanRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'paused',
          retryCount: 3,
        })
      );
    });
  });

  describe('pagination', () => {
    it('should process multiple plans in a batch', async () => {
      const plan1 = createTestRecurringPlan({ planCode: 'RC_1' });
      plan1.authorizationCode_encrypted = {
        ciphertext: 'enc1',
        iv: 'iv1',
        version: 1,
        keyId: 'dev-key',
      };

      const plan2 = createTestRecurringPlan({ planCode: 'RC_2' });
      plan2.authorizationCode_encrypted = {
        ciphertext: 'enc2',
        iv: 'iv2',
        version: 1,
        keyId: 'dev-key',
      };

      const mockPlanRef1 = { update: jest.fn().mockResolvedValue(undefined) };
      const mockPlanRef2 = { update: jest.fn().mockResolvedValue(undefined) };

      let callCount = 0;
      const mockOrphanageDoc = {
        get: jest.fn().mockResolvedValue(
          createMockDocSnapshot(true, createTestOrphanage())
        ),
      };

      mockFirestore.collection.mockImplementation((name: string) => {
        if (name === 'recurringPlans') {
          return {
            ...mockCollectionRef,
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            get: jest.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                return Promise.resolve(
                  createMockQuerySnapshot([
                    { id: 'plan-1', data: plan1, ref: mockPlanRef1 },
                    { id: 'plan-2', data: plan2, ref: mockPlanRef2 },
                  ])
                );
              }
              return Promise.resolve(createMockQuerySnapshot([]));
            }),
          };
        }
        if (name === 'orphanages') {
          return {
            ...mockCollectionRef,
            doc: jest.fn().mockReturnValue(mockOrphanageDoc),
          };
        }
        return mockCollectionRef;
      });

      await runScheduledFunction();

      // Should have charged both plans
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockPlanRef1.update).toHaveBeenCalled();
      expect(mockPlanRef2.update).toHaveBeenCalled();
    });
  });
});
