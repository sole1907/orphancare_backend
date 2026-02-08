// Tests for getRecurringPlans.ts

jest.mock('firebase-functions/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn((options, handler) => handler),
}));

// Mock authUtils
const mockVerifyAuth = jest.fn();
jest.mock('../../functions/src/lib/authUtils', () => ({
  verifyAuth: mockVerifyAuth,
}));

import {
  mockFirestore,
  mockCollectionRef,
  mockDocRef,
  createMockDocSnapshot,
  createMockQuerySnapshot,
} from '../setup/firebaseMocks';
import { createMockRequest, createMockResponse } from '../setup/testHelpers';
import { getRecurringPlans } from '../../functions/src/getRecurringPlans';

describe('getRecurringPlans', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default auth success as donor
    mockVerifyAuth.mockResolvedValue({ uid: 'donor-123', donor: true });

    // Default empty getAll response
    mockFirestore.getAll = jest.fn().mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should reject unauthenticated requests', async () => {
      mockVerifyAuth.mockRejectedValue({ code: 401, message: 'Unauthorized' });

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      expect(res.statusCode).toBe(401);
    });

    it('should require donor role', async () => {
      mockVerifyAuth.mockRejectedValue({ code: 403, message: 'Forbidden' });

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      expect(res.statusCode).toBe(403);
    });
  });

  describe('query building', () => {
    it('should query recurring plans by donorUid', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      expect(mockFirestore.collection).toHaveBeenCalledWith('recurringPlans');
      expect(mockCollectionRef.where).toHaveBeenCalledWith('donorUid', '==', 'donor-123');
      expect(mockCollectionRef.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    });

    it('should filter by status when provided', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({
        method: 'POST',
        body: { status: 'active' },
      });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      expect(mockCollectionRef.where).toHaveBeenCalledWith('status', '==', 'active');
    });

    it('should accept valid status values', async () => {
      const validStatuses = ['active', 'pending', 'cancelled', 'paused'];

      for (const status of validStatuses) {
        mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));
        mockCollectionRef.where.mockClear();

        const req = createMockRequest({
          method: 'POST',
          body: { status },
        });
        const res = createMockResponse();

        await getRecurringPlans(req, res);

        expect(mockCollectionRef.where).toHaveBeenCalledWith('status', '==', status);
      }
    });

    it('should ignore invalid status values', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({
        method: 'POST',
        body: { status: 'invalid' },
      });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      const whereCalls = mockCollectionRef.where.mock.calls;
      const statusCalls = whereCalls.filter((call: string[]) => call[0] === 'status');
      expect(statusCalls.length).toBe(0);
    });
  });

  describe('pagination', () => {
    it('should use cursor-based pagination', async () => {
      const mockLastDoc = createMockDocSnapshot(true, { createdAt: new Date() });
      mockDocRef.get.mockResolvedValue(mockLastDoc);
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({
        method: 'POST',
        body: { lastDocId: 'plan-123' },
      });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      expect(mockCollectionRef.doc).toHaveBeenCalledWith('plan-123');
      expect(mockCollectionRef.startAfter).toHaveBeenCalled();
    });

    it('should return hasMore: true when more plans exist', async () => {
      const plans = Array.from({ length: 21 }, (_, i) => ({
        id: `plan-${i}`,
        data: {
          planCode: `RC_test_${i}`,
          status: 'active',
          interval: 'monthly',
          baseAmount: 5000,
        },
      }));
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(plans));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.hasMore).toBe(true);
      expect(data.plans.length).toBe(20);
    });

    it('should return hasMore: false when no more plans', async () => {
      const plans = [
        { id: 'plan-1', data: { planCode: 'RC_test_1', status: 'active' } },
      ];
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(plans));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.hasMore).toBe(false);
    });
  });

  describe('response structure', () => {
    it('should return properly structured plan items', async () => {
      const plans = [
        {
          id: 'plan-1',
          data: {
            planCode: 'RC_test_123',
            status: 'active',
            interval: 'monthly',
            baseAmount: 5000,
            grossAmount: 5600,
            childId: 'child-1',
            orphanageId: 'orphanage-1',
            createdAt: new Date('2024-01-15'),
            nextChargeAt: new Date('2024-02-15'),
            cancelledAt: null,
          },
        },
      ];
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(plans));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.plans[0]).toMatchObject({
        planCode: 'RC_test_123',
        status: 'active',
        interval: 'monthly',
        baseAmount: 5000,
        grossAmount: 5600,
        childId: 'child-1',
        orphanageId: 'orphanage-1',
      });
    });

    it('should use planCode from document or default to doc.id', async () => {
      const plans = [
        {
          id: 'plan-without-code',
          data: {
            status: 'active',
            interval: 'monthly',
            baseAmount: 5000,
          },
        },
      ];
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(plans));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.plans[0].planCode).toBe('plan-without-code');
    });

    it('should default interval to monthly', async () => {
      const plans = [
        {
          id: 'plan-1',
          data: { planCode: 'RC_test', status: 'active', baseAmount: 5000 },
        },
      ];
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(plans));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.plans[0].interval).toBe('monthly');
    });

    it('should return empty array when no plans', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.plans).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.lastDocId).toBeNull();
    });
  });

  describe('data enrichment', () => {
    it('should fetch child and orphanage details', async () => {
      const plans = [
        {
          id: 'plan-1',
          data: {
            planCode: 'RC_test_123',
            status: 'active',
            childId: 'child-1',
            orphanageId: 'orphanage-1',
          },
        },
      ];
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(plans));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

      expect(mockFirestore.getAll).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 on Firestore error', async () => {
      mockCollectionRef.get.mockRejectedValue(new Error('Firestore error'));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getRecurringPlans(req, res);

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

      await getRecurringPlans(req, res);

      expect(res.statusCode).toBe(204);
    });
  });
});
