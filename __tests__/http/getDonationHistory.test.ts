// Tests for getDonationHistory.ts

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
import { getDonationHistory } from '../../functions/src/getDonationHistory';

describe('getDonationHistory', () => {
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

      await getDonationHistory(req, res);

      expect(res.statusCode).toBe(401);
    });

    it('should require donor role', async () => {
      mockVerifyAuth.mockRejectedValue({ code: 403, message: 'Forbidden' });

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      expect(res.statusCode).toBe(403);
    });
  });

  describe('query building', () => {
    it('should query donations by donorUid', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      expect(mockFirestore.collection).toHaveBeenCalledWith('donations');
      expect(mockCollectionRef.where).toHaveBeenCalledWith('donorUid', '==', 'donor-123');
      expect(mockCollectionRef.orderBy).toHaveBeenCalledWith('createdAt', 'desc');
    });

    it('should filter by status when provided', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({
        method: 'POST',
        body: { status: 'success' },
      });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      expect(mockCollectionRef.where).toHaveBeenCalledWith('status', '==', 'success');
    });

    it('should ignore invalid status values', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({
        method: 'POST',
        body: { status: 'invalid' },
      });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      // Should not call where with invalid status
      const whereCalls = mockCollectionRef.where.mock.calls;
      const statusCalls = whereCalls.filter((call: string[]) => call[0] === 'status');
      expect(statusCalls.length).toBe(0);
    });

    it('should apply limit', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({
        method: 'POST',
        body: { limit: 10 },
      });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      expect(mockCollectionRef.limit).toHaveBeenCalledWith(11); // limit + 1 for hasMore check
    });

    it('should use default limit of 20', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      expect(mockCollectionRef.limit).toHaveBeenCalledWith(21);
    });
  });

  describe('pagination', () => {
    it('should use cursor-based pagination with lastDocId', async () => {
      const mockLastDoc = createMockDocSnapshot(true, { createdAt: new Date() });
      mockDocRef.get.mockResolvedValue(mockLastDoc);
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({
        method: 'POST',
        body: { lastDocId: 'last-doc-123' },
      });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      expect(mockCollectionRef.doc).toHaveBeenCalledWith('last-doc-123');
      expect(mockCollectionRef.startAfter).toHaveBeenCalled();
    });

    it('should return hasMore: true when more documents exist', async () => {
      // Return more documents than limit
      const donations = Array.from({ length: 21 }, (_, i) => ({
        id: `donation-${i}`,
        data: {
          donorUid: 'donor-123',
          baseAmount: 5000,
          status: 'success',
          childId: 'child-1',
          orphanageId: 'orphanage-1',
        },
      }));
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(donations));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.hasMore).toBe(true);
      expect(data.donations.length).toBe(20);
    });

    it('should return hasMore: false when no more documents', async () => {
      const donations = [
        { id: 'donation-1', data: { donorUid: 'donor-123', baseAmount: 5000, status: 'success' } },
      ];
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(donations));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.hasMore).toBe(false);
    });

    it('should return lastDocId for pagination', async () => {
      const donations = [
        { id: 'donation-1', data: { baseAmount: 5000, status: 'success' } },
        { id: 'donation-2', data: { baseAmount: 3000, status: 'success' } },
      ];
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(donations));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.lastDocId).toBe('donation-2');
    });
  });

  describe('data enrichment', () => {
    it('should fetch child and orphanage details', async () => {
      const donations = [
        {
          id: 'donation-1',
          data: {
            baseAmount: 5000,
            status: 'success',
            childId: 'child-1',
            orphanageId: 'orphanage-1',
          },
        },
      ];
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(donations));

      // Mock getAll for children
      mockFirestore.getAll = jest.fn().mockImplementation((...refs) => {
        return Promise.resolve(
          refs.map((ref: any) => {
            if (ref._path?.includes('children')) {
              return {
                exists: true,
                id: 'child-1',
                data: () => ({ name: 'Test Child', photoUrl: 'https://example.com/photo.jpg' }),
              };
            }
            if (ref._path?.includes('orphanages')) {
              return {
                exists: true,
                id: 'orphanage-1',
                data: () => ({ name: 'Test Orphanage' }),
              };
            }
            return { exists: false };
          })
        );
      });

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      expect(mockFirestore.getAll).toHaveBeenCalled();
    });
  });

  describe('response structure', () => {
    it('should return properly structured donation items', async () => {
      const donations = [
        {
          id: 'donation-1',
          data: {
            baseAmount: 5000,
            tipAmount: 500,
            paystackFee: 100,
            netAmount: 5500,
            status: 'success',
            childId: 'child-1',
            orphanageId: 'orphanage-1',
            recurring: true,
            interval: 'monthly',
            createdAt: new Date('2024-01-15'),
          },
        },
      ];
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot(donations));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.donations[0]).toMatchObject({
        id: 'donation-1',
        baseAmount: 5000,
        tipAmount: 500,
        paystackFee: 100,
        status: 'success',
        childId: 'child-1',
        orphanageId: 'orphanage-1',
        recurring: true,
        interval: 'monthly',
      });
    });

    it('should return empty array when no donations', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getDonationHistory(req, res);

      const data = JSON.parse(res._getData()).data;
      expect(data.donations).toEqual([]);
      expect(data.hasMore).toBe(false);
      expect(data.lastDocId).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return 500 on Firestore error', async () => {
      mockCollectionRef.get.mockRejectedValue(new Error('Firestore error'));

      const req = createMockRequest({ method: 'POST', body: {} });
      const res = createMockResponse();

      await getDonationHistory(req, res);

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

      await getDonationHistory(req, res);

      expect(res.statusCode).toBe(204);
    });
  });
});
