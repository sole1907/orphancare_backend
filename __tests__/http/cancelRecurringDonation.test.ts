// Tests for cancelRecurringDonation.ts

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
  createMockQuerySnapshot,
} from '../setup/firebaseMocks';
import { createMockRequest, createMockResponse } from '../setup/testHelpers';
import { cancelRecurringDonation } from '../../functions/src/cancelRecurringDonation';

describe('cancelRecurringDonation', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default auth success as donor
    mockVerifyAuth.mockResolvedValue({ uid: 'donor-123', donor: true });
  });

  describe('authentication', () => {
    it('should reject unauthenticated requests', async () => {
      mockVerifyAuth.mockRejectedValue({ code: 401, message: 'No token provided' });

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(401);
      expect(res._getData()).toContain('No token provided');
    });

    it('should require donor role', async () => {
      mockVerifyAuth.mockRejectedValue({ code: 403, message: 'Forbidden' });

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(403);
    });
  });

  describe('validation', () => {
    it('should reject request without planCode', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {},
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('planCode is required');
    });
  });

  describe('plan lookup', () => {
    it('should return 404 when plan not found', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_nonexistent' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(404);
      expect(res._getData()).toContain('Recurring plan not found');
    });

    it('should query by planCode', async () => {
      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'donor-123', status: 'active' },
            ref: mockPlanRef,
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(mockFirestore.collection).toHaveBeenCalledWith('recurringPlans');
      expect(mockCollectionRef.where).toHaveBeenCalledWith('planCode', '==', 'RC_test_123');
      expect(mockCollectionRef.limit).toHaveBeenCalledWith(1);
    });
  });

  describe('ownership verification', () => {
    it('should reject cancellation of plans owned by others', async () => {
      mockVerifyAuth.mockResolvedValue({ uid: 'donor-123', donor: true });
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'other-donor', status: 'active' },
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getData()).toContain('do not have permission');
    });
  });

  describe('status validation', () => {
    it('should allow cancellation of active plans', async () => {
      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'donor-123', status: 'active' },
            ref: mockPlanRef,
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockPlanRef.update).toHaveBeenCalled();
    });

    it('should allow cancellation of pending plans', async () => {
      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'donor-123', status: 'pending' },
            ref: mockPlanRef,
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(200);
    });

    it('should reject cancellation of already cancelled plans', async () => {
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'donor-123', status: 'cancelled' },
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Cannot cancel a plan with status: cancelled');
    });

    it('should reject cancellation of failed plans', async () => {
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'donor-123', status: 'failed' },
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Cannot cancel a plan with status: failed');
    });
  });

  describe('plan update', () => {
    it('should update plan status to cancelled', async () => {
      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'donor-123', status: 'active' },
            ref: mockPlanRef,
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(mockPlanRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'cancelled',
          cancellationReason: null,
        })
      );
    });

    it('should store cancellation reason when provided', async () => {
      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'donor-123', status: 'active' },
            ref: mockPlanRef,
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: {
          planCode: 'RC_test_123',
          cancellationReason: 'Financial constraints',
        },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(mockPlanRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'cancelled',
          cancellationReason: 'Financial constraints',
        })
      );
    });

    it('should set cancelledAt timestamp', async () => {
      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'donor-123', status: 'active' },
            ref: mockPlanRef,
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(mockPlanRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          cancelledAt: expect.anything(),
        })
      );
    });
  });

  describe('success response', () => {
    it('should return success response', async () => {
      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'donor-123', status: 'active' },
            ref: mockPlanRef,
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.success).toBe(true);
      expect(data.message).toContain('cancelled successfully');
    });
  });

  describe('error handling', () => {
    it('should return 500 on Firestore error', async () => {
      mockCollectionRef.get.mockRejectedValue(new Error('Firestore error'));

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getData()).toContain('Internal error');
    });

    it('should return 500 on update error', async () => {
      const mockPlanRef = { update: jest.fn().mockRejectedValue(new Error('Update failed')) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'plan-1',
            data: { planCode: 'RC_test_123', donorUid: 'donor-123', status: 'active' },
            ref: mockPlanRef,
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { planCode: 'RC_test_123' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(500);
    });
  });

  describe('CORS handling', () => {
    it('should handle OPTIONS preflight request', async () => {
      const req = createMockRequest({
        method: 'OPTIONS',
        headers: { origin: 'https://app.orphancare.org' },
      });
      const res = createMockResponse();

      await cancelRecurringDonation(req, res);

      expect(res.statusCode).toBe(204);
    });
  });
});
