// Tests for slaHealthCheck.ts

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

jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn(() => ({ value: () => 'sk_test_xxx' })),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

import {
  mockFirestore,
  mockCollectionRef,
  mockDocRef,
  createMockDocSnapshot,
} from '../setup/firebaseMocks';

// Import after mocking
import '../../functions/src/slaHealthCheck';

describe('slaHealthCheck', () => {
  const runScheduledFunction = async () => {
    if (!scheduledHandler) {
      throw new Error('Scheduled handler not registered');
    }
    await scheduledHandler();
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock for successful responses
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
    });

    // Default Firestore mocks
    mockDocRef.get.mockResolvedValue(
      createMockDocSnapshot(false, {}) // No SLA config by default
    );
    mockCollectionRef.add.mockResolvedValue({ id: 'health-check-id' });
  });

  describe('basic functionality', () => {
    it('should register the scheduled handler', () => {
      expect(scheduledHandler).not.toBeNull();
    });

    it('should run infrastructure checks', async () => {
      await runScheduledFunction();

      // Should check Firestore
      expect(mockFirestore.collection).toHaveBeenCalledWith('_health');

      // Should check Paystack
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/bank?country=nigeria'),
        expect.any(Object)
      );
    });

    it('should store health check result', async () => {
      await runScheduledFunction();

      expect(mockFirestore.collection).toHaveBeenCalledWith('healthCheckHistory');
      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          overallStatus: expect.stringMatching(/healthy|degraded|unhealthy/),
          infrastructure: expect.objectContaining({
            firestore: expect.objectContaining({ status: expect.any(String) }),
            paystack: expect.objectContaining({ status: expect.any(String) }),
          }),
        })
      );
    });
  });

  describe('infrastructure checks', () => {
    it('should report healthy when all checks pass', async () => {
      // Firestore check will pass (mocked)
      // Paystack check will pass (mocked)

      await runScheduledFunction();

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          overallStatus: 'healthy',
        })
      );
    });

    it('should report degraded when some checks fail', async () => {
      // Make Paystack fail
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/bank')) {
          return Promise.resolve({
            ok: false,
            status: 500,
          });
        }
        return Promise.resolve({ ok: true, status: 200 });
      });

      await runScheduledFunction();

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          overallStatus: 'degraded',
          infrastructure: expect.objectContaining({
            paystack: expect.objectContaining({
              status: 'fail',
              error: expect.stringContaining('500'),
            }),
          }),
        })
      );
    });

    it('should handle Paystack network error', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/bank')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: true, status: 200 });
      });

      await runScheduledFunction();

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          infrastructure: expect.objectContaining({
            paystack: expect.objectContaining({
              status: 'fail',
              error: 'Network error',
            }),
          }),
        })
      );
    });

    it('should measure latency for infrastructure checks', async () => {
      await runScheduledFunction();

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          infrastructure: expect.objectContaining({
            firestore: expect.objectContaining({
              latencyMs: expect.any(Number),
            }),
            paystack: expect.objectContaining({
              latencyMs: expect.any(Number),
            }),
          }),
        })
      );
    });
  });

  describe('endpoint checks', () => {
    it('should check default healthCheck endpoint when no config', async () => {
      // No SLA config document exists
      mockDocRef.get.mockResolvedValue(createMockDocSnapshot(false, {}));

      await runScheduledFunction();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/healthCheck'),
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should check configured endpoints', async () => {
      // SLA config with custom endpoints
      mockFirestore.doc.mockReturnValue({
        get: jest.fn().mockResolvedValue(
          createMockDocSnapshot(true, {
            endpoints: [
              { name: 'healthCheck', path: '/healthCheck', method: 'GET' },
              { name: 'calculateFee', path: '/calculateDonationFee', method: 'POST', testPayload: { baseAmount: 1000, tipPercent: 0 } },
            ],
          })
        ),
      });

      await runScheduledFunction();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/healthCheck'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/calculateDonationFee'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ baseAmount: 1000, tipPercent: 0 }),
        })
      );
    });

    it('should skip endpoints requiring authentication', async () => {
      mockFirestore.doc.mockReturnValue({
        get: jest.fn().mockResolvedValue(
          createMockDocSnapshot(true, {
            endpoints: [
              { name: 'healthCheck', path: '/healthCheck', method: 'GET' },
              { name: 'getDonorProfile', path: '/getDonorProfile', method: 'GET', requiresAuth: true },
            ],
          })
        ),
      });

      await runScheduledFunction();

      // Should store result indicating auth endpoint was skipped
      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoints: expect.objectContaining({
            getDonorProfile: expect.objectContaining({
              status: 'pass',
              error: 'Skipped - requires authentication',
            }),
          }),
        })
      );
    });

    it('should report failed endpoints', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/healthCheck')) {
          return Promise.resolve({ ok: false, status: 503 });
        }
        return Promise.resolve({ ok: true, status: 200 });
      });

      await runScheduledFunction();

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoints: expect.objectContaining({
            healthCheck: expect.objectContaining({
              status: 'fail',
              httpStatus: 503,
              error: expect.stringContaining('503'),
            }),
          }),
        })
      );
    });

    it('should handle endpoint network errors', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/healthCheck')) {
          return Promise.reject(new Error('Connection refused'));
        }
        return Promise.resolve({ ok: true, status: 200 });
      });

      await runScheduledFunction();

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoints: expect.objectContaining({
            healthCheck: expect.objectContaining({
              status: 'fail',
              error: 'Connection refused',
            }),
          }),
        })
      );
    });
  });

  describe('overall status determination', () => {
    it('should be healthy when all infrastructure and endpoints pass', async () => {
      await runScheduledFunction();

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          overallStatus: 'healthy',
        })
      );
    });

    it('should be degraded when some services pass', async () => {
      // Paystack fails
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/bank')) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({ ok: true, status: 200 });
      });

      await runScheduledFunction();

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          overallStatus: 'degraded',
        })
      );
    });
  });

  describe('error handling', () => {
    it('should handle SLA config fetch error gracefully', async () => {
      // Mock doc to throw error when fetching config
      const originalDoc = mockFirestore.doc;
      mockFirestore.doc = jest.fn().mockReturnValue({
        get: jest.fn().mockRejectedValue(new Error('Config fetch failed')),
      });

      // Should not throw - falls back to default endpoint
      await runScheduledFunction();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/healthCheck'),
        expect.any(Object)
      );

      // Restore original mock
      mockFirestore.doc = originalDoc;
    });

    it('should throw on critical error', async () => {
      // Save original and restore after test
      const originalCollection = mockFirestore.collection;

      mockFirestore.collection.mockImplementation((name: string) => {
        if (name === 'healthCheckHistory') {
          throw new Error('Database unavailable');
        }
        return mockCollectionRef;
      });

      await expect(runScheduledFunction()).rejects.toThrow('Database unavailable');

      // Restore original mock
      mockFirestore.collection = originalCollection;
    });
  });
});
