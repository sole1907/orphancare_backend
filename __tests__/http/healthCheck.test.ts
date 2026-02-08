// Tests for health.ts

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

import { mockFirestore, mockCollectionRef, mockDocRef, createMockDocSnapshot } from '../setup/firebaseMocks';
import { createMockRequest, createMockResponse, createPreflightRequest } from '../setup/testHelpers';

// Mock fetch for Paystack health check
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Import the functions after mocking
import { healthCheck, healthCheckDeep } from '../../functions/src/health';

describe('health endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();

    // Default Firestore mock - successful
    mockDocRef.get.mockResolvedValue(createMockDocSnapshot(true, {}));

    // Default Paystack mock - successful
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ status: true }),
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status when all checks pass', async () => {
      const req = createMockRequest({
        method: 'GET',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      await healthCheck(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.status).toBe('healthy');
      expect(data.checks.firestore.status).toBe('pass');
      expect(data.checks.paystack.status).toBe('pass');
    });

    it('should return degraded status when Paystack fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const req = createMockRequest({
        method: 'GET',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      await healthCheck(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.status).toBe('degraded');
      expect(data.checks.firestore.status).toBe('pass');
      expect(data.checks.paystack.status).toBe('fail');
    });

    it('should return degraded status when Firestore fails', async () => {
      mockDocRef.get.mockRejectedValue(new Error('Firestore connection failed'));

      const req = createMockRequest({
        method: 'GET',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      await healthCheck(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.status).toBe('degraded');
      expect(data.checks.firestore.status).toBe('fail');
      expect(data.checks.paystack.status).toBe('pass');
    });

    it('should return unhealthy status when all checks fail', async () => {
      mockDocRef.get.mockRejectedValue(new Error('Firestore error'));
      mockFetch.mockRejectedValue(new Error('Network error'));

      const req = createMockRequest({
        method: 'GET',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      await healthCheck(req, res);

      expect(res.statusCode).toBe(503);
      const data = JSON.parse(res._getData());
      expect(data.status).toBe('unhealthy');
    });

    it('should handle CORS preflight request', async () => {
      const req = createPreflightRequest('https://orphancare-93b41.web.app');
      const res = createMockResponse();

      await healthCheck(req, res);

      expect(res.statusCode).toBe(204);
    });

    it('should include latency metrics in response', async () => {
      const req = createMockRequest({
        method: 'GET',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      await healthCheck(req, res);

      const data = JSON.parse(res._getData());
      expect(data.checks.firestore.latencyMs).toBeGreaterThanOrEqual(0);
      expect(data.checks.paystack.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should include timestamp and version', async () => {
      const req = createMockRequest({
        method: 'GET',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      await healthCheck(req, res);

      const data = JSON.parse(res._getData());
      expect(data.timestamp).toBeDefined();
      expect(data.version).toBeDefined();
    });

    it('should handle Paystack network timeout', async () => {
      mockFetch.mockRejectedValue(new Error('Request timeout'));

      const req = createMockRequest({
        method: 'GET',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      await healthCheck(req, res);

      const data = JSON.parse(res._getData());
      expect(data.checks.paystack.status).toBe('fail');
      expect(data.checks.paystack.error).toContain('timeout');
    });
  });

  describe('healthCheckDeep', () => {
    beforeEach(() => {
      process.env.ENV_TYPE = 'development';
      process.env.ADMIN_HEALTH_KEY = 'test-admin-key';

      // Mock collection counts
      mockCollectionRef.count.mockReturnValue({
        get: jest.fn().mockResolvedValue({ data: () => ({ count: 10 }) }),
      });
    });

    it('should return detailed stats for authorized request', async () => {
      const req = createMockRequest({
        method: 'GET',
        headers: {
          origin: 'https://orphancare-93b41.web.app',
          'x-admin-key': 'test-admin-key',
        },
      });
      const res = createMockResponse();

      await healthCheckDeep(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.collections).toBeDefined();
      expect(data.environment).toBeDefined();
    });

    it('should reject unauthorized request in production', async () => {
      process.env.ENV_TYPE = 'production';

      const req = createMockRequest({
        method: 'GET',
        headers: {
          origin: 'https://orphancare-93b41.web.app',
          'x-admin-key': 'wrong-key',
        },
      });
      const res = createMockResponse();

      await healthCheckDeep(req, res);

      expect(res.statusCode).toBe(401);
    });

    it('should allow request without admin key in development', async () => {
      process.env.ENV_TYPE = 'development';

      const req = createMockRequest({
        method: 'GET',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      await healthCheckDeep(req, res);

      expect(res.statusCode).toBe(200);
    });

    it('should include collection counts', async () => {
      const req = createMockRequest({
        method: 'GET',
        headers: {
          origin: 'https://orphancare-93b41.web.app',
          'x-admin-key': 'test-admin-key',
        },
      });
      const res = createMockResponse();

      await healthCheckDeep(req, res);

      const data = JSON.parse(res._getData());
      expect(data.collections.donors).toBeDefined();
      expect(data.collections.orphanages).toBeDefined();
      expect(data.collections.donations).toBeDefined();
      expect(data.collections.recurringPlans).toBeDefined();
    });

    it('should handle CORS preflight', async () => {
      const req = createPreflightRequest('https://orphancare-93b41.web.app');
      const res = createMockResponse();

      await healthCheckDeep(req, res);

      expect(res.statusCode).toBe(204);
    });
  });
});
