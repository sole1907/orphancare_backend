// Tests for checkDonationStatus.ts

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

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

import {
  mockFirestore,
  mockCollectionRef,
  createMockQuerySnapshot,
} from '../setup/firebaseMocks';
import { createMockRequest, createMockResponse } from '../setup/testHelpers';
import { checkDonationStatus } from '../../functions/src/checkDonationStatus';

describe('checkDonationStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default auth success
    mockVerifyAuth.mockResolvedValue({ uid: 'donor-123' });

    // Default Paystack response
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ status: true, data: { status: 'pending' } }),
    });
  });

  describe('authentication', () => {
    it('should reject unauthenticated requests', async () => {
      mockVerifyAuth.mockRejectedValue({ code: 401, message: 'Unauthorized' });

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_123' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      expect(res.statusCode).toBe(401);
    });
  });

  describe('validation', () => {
    it('should reject request without reference', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: {},
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Missing reference');
    });
  });

  describe('cached status lookup', () => {
    it('should return cached success status from database', async () => {
      const mockDonationRef = { update: jest.fn() };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'donation-1',
            data: { paystackRef: 'ref_123', status: 'success' },
            ref: mockDonationRef,
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_123' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.status).toBe('success');
      expect(mockFetch).not.toHaveBeenCalled(); // Should not call Paystack
    });

    it('should return cached failed status from database', async () => {
      const mockDonationRef = { update: jest.fn() };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'donation-1',
            data: { paystackRef: 'ref_123', status: 'failed' },
            ref: mockDonationRef,
          },
        ])
      );

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_123' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.status).toBe('failed');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should call Paystack for pending status', async () => {
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'donation-1',
            data: { paystackRef: 'ref_123', status: 'pending' },
            ref: { update: jest.fn().mockResolvedValue(undefined) },
          },
        ])
      );

      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ status: true, data: { status: 'success' } }),
      });

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_123' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/transaction/verify/ref_123'),
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk_test_xxx',
          }),
        })
      );
    });
  });

  describe('Paystack verification', () => {
    it('should update donation status when Paystack returns success', async () => {
      const mockDonationRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'donation-1',
            data: { paystackRef: 'ref_123', status: 'pending' },
            ref: mockDonationRef,
          },
        ])
      );

      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ status: true, data: { status: 'success' } }),
      });

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_123' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      expect(mockDonationRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'success',
          updatedAt: expect.any(Date),
        })
      );

      const data = JSON.parse(res._getData());
      expect(data.status).toBe('success');
    });

    it('should update donation status when Paystack returns failed', async () => {
      const mockDonationRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'donation-1',
            data: { paystackRef: 'ref_123', status: 'pending' },
            ref: mockDonationRef,
          },
        ])
      );

      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ status: true, data: { status: 'failed' } }),
      });

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_123' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      expect(mockDonationRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
        })
      );
    });

    it('should return pending if Paystack returns pending', async () => {
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'donation-1',
            data: { paystackRef: 'ref_123', status: 'pending' },
            ref: { update: jest.fn() },
          },
        ])
      );

      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ status: true, data: { status: 'pending' } }),
      });

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_123' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      const data = JSON.parse(res._getData());
      expect(data.status).toBe('pending');
    });
  });

  describe('donation not found', () => {
    it('should call Paystack when donation not in database', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ status: true, data: { status: 'pending' } }),
      });

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_unknown' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      expect(mockFetch).toHaveBeenCalled();
    });

    it('should return 404 when Paystack returns success but donation not in db', async () => {
      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({ status: true, data: { status: 'success' } }),
      });

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_unknown' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      expect(res.statusCode).toBe(404);
      expect(res._getData()).toContain('Donation not found');
    });
  });

  describe('error handling', () => {
    it('should return 500 on Firestore error', async () => {
      mockCollectionRef.get.mockRejectedValue(new Error('Firestore error'));

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_123' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getData()).toContain('Internal error');
    });

    it('should return 500 on Paystack API error', async () => {
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'donation-1',
            data: { paystackRef: 'ref_123', status: 'pending' },
            ref: { update: jest.fn() },
          },
        ])
      );

      mockFetch.mockRejectedValue(new Error('Paystack API error'));

      const req = createMockRequest({
        method: 'POST',
        body: { reference: 'ref_123' },
      });
      const res = createMockResponse();

      await checkDonationStatus(req, res);

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

      await checkDonationStatus(req, res);

      expect(res.statusCode).toBe(204);
    });
  });
});
