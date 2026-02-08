// Tests for paystackWebhook.ts

import * as crypto from 'crypto';

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

import {
  mockFirestore,
  mockCollectionRef,
  mockDocRef,
  createMockQuerySnapshot,
  createMockDocSnapshot,
} from '../setup/firebaseMocks';
import { mockSecretValues } from '../setup/secretMocks';
import {
  createMockRequest,
  createMockResponse,
  createWebhookRequest,
  generatePaystackSignature,
} from '../setup/testHelpers';
import { buildChargeSuccessEvent, buildChargeFailedEvent } from '../mocks/paystack.mock';

// Import after mocking
import { paystackWebhook } from '../../functions/src/paystackWebhook';

describe('paystackWebhook', () => {
  const paystackSecret = mockSecretValues.PAYSTACK_SECRET_KEY;
  const allowedIps = ['52.31.139.75', '52.49.173.169', '52.214.14.220'];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('security checks', () => {
    it('should reject requests from unauthorized IP', async () => {
      const event = buildChargeSuccessEvent();
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, '1.2.3.4');
      const res = createMockResponse();

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(403);
      expect(res._getData()).toContain('Forbidden');
    });

    it('should accept requests from allowed IPs', async () => {
      const event = buildChargeSuccessEvent();
      const signature = generatePaystackSignature(event, paystackSecret);

      for (const ip of allowedIps) {
        const req = createWebhookRequest(event, signature, ip);
        const res = createMockResponse();

        // Mock the donation query
        mockCollectionRef.get.mockResolvedValue(
          createMockQuerySnapshot([{ id: 'donation-1', data: { donorUid: 'test-donor' } }])
        );

        await paystackWebhook(req, res);

        expect(res.statusCode).toBe(200);
      }
    });

    it('should reject requests with invalid signature', async () => {
      const event = buildChargeSuccessEvent();
      const req = createWebhookRequest(event, 'invalid-signature', allowedIps[0]);
      const res = createMockResponse();

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Invalid signature');
    });

    it('should accept requests with valid signature', async () => {
      const event = buildChargeSuccessEvent();
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, allowedIps[0]);
      const res = createMockResponse();

      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([{ id: 'donation-1', data: { donorUid: 'test-donor' } }])
      );

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(200);
    });
  });

  describe('charge.success - one-off donations', () => {
    it('should update donation status to success', async () => {
      const event = buildChargeSuccessEvent({ reference: 'ref-123' });
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, allowedIps[0]);
      const res = createMockResponse();

      const mockDonationRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'donation-1',
            data: { donorUid: 'test-donor', baseAmount: 5000 },
            ref: mockDonationRef,
          },
        ])
      );

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getData()).toContain('One-off success processed');
      expect(mockDonationRef.update).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success' })
      );
    });

    it('should update donor lifetime donations', async () => {
      const event = buildChargeSuccessEvent({ reference: 'ref-123' });
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, allowedIps[0]);
      const res = createMockResponse();

      const mockDonorRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.doc.mockReturnValue(mockDonorRef);

      const mockDonationRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'donation-1',
            data: { donorUid: 'test-donor', baseAmount: 5000 },
            ref: mockDonationRef,
          },
        ])
      );

      await paystackWebhook(req, res);

      expect(mockDonorRef.update).toHaveBeenCalled();
    });

    it('should log error when donation not found', async () => {
      const event = buildChargeSuccessEvent({ reference: 'unknown-ref' });
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, allowedIps[0]);
      const res = createMockResponse();

      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      await paystackWebhook(req, res);

      // Should still return 200 to acknowledge webhook
      expect(res.statusCode).toBe(200);
    });
  });

  describe('charge.success - recurring donations', () => {
    it('should handle first recurring charge with reusable authorization', async () => {
      const event = buildChargeSuccessEvent({
        reference: 'ref-recurring-123',
        planCode: 'RC_test_123',
        recurring: true,
        reusable: true,
      });
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, allowedIps[0]);
      const res = createMockResponse();

      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.doc.mockReturnValue({
        get: jest.fn().mockResolvedValue(
          createMockDocSnapshot(true, {
            planCode: 'RC_test_123',
            interval: 'monthly',
            donorUid: 'test-donor',
            status: 'pending',
          })
        ),
        ...mockPlanRef,
      });

      // Mock donation lookup by reference
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          {
            id: 'donation-1',
            data: { status: 'pending' },
            ref: { update: jest.fn().mockResolvedValue(undefined) },
          },
        ])
      );

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getData()).toContain('Recurring donation processed');
    });

    it('should reject non-reusable authorization for recurring', async () => {
      const event = buildChargeSuccessEvent({
        reference: 'ref-recurring-123',
        planCode: 'RC_test_123',
        recurring: true,
        reusable: false,
      });
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, allowedIps[0]);
      const res = createMockResponse();

      const mockPlanRef = { update: jest.fn().mockResolvedValue(undefined) };

      // Create a document snapshot that uses our mockPlanRef for the ref property
      const mockDocSnapshotWithRef = {
        exists: true,
        id: 'RC_test_123',
        data: () => ({
          planCode: 'RC_test_123',
          interval: 'monthly',
          status: 'pending',
          // No authorizationCode_encrypted means isFirstCharge = true
        }),
        ref: mockPlanRef,
      };

      const mockPlanDocReturn = {
        get: jest.fn().mockResolvedValue(mockDocSnapshotWithRef),
        ...mockPlanRef,
      };

      // Mock the collection chain for recurringPlans
      mockFirestore.collection.mockImplementation((name: string) => {
        if (name === 'recurringPlans') {
          return {
            ...mockCollectionRef,
            doc: jest.fn().mockReturnValue(mockPlanDocReturn),
          };
        }
        return mockCollectionRef;
      });

      await paystackWebhook(req, res);

      expect(mockPlanRef.update).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          lastError: 'Card authorization is not reusable',
        })
      );
    });
  });

  describe('charge.failed', () => {
    it('should update donation status to failed', async () => {
      const event = buildChargeFailedEvent({ reference: 'ref-failed-123' });
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, allowedIps[0]);
      const res = createMockResponse();

      const mockDonationRef = { update: jest.fn().mockResolvedValue(undefined) };
      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([
          { id: 'donation-1', data: {}, ref: mockDonationRef },
        ])
      );

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getData()).toContain('One-off failure processed');
    });

    it('should log error when failed donation not found', async () => {
      const event = buildChargeFailedEvent({ reference: 'unknown-ref' });
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, allowedIps[0]);
      const res = createMockResponse();

      mockCollectionRef.get.mockResolvedValue(createMockQuerySnapshot([]));

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      const event = buildChargeSuccessEvent();
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, allowedIps[0]);
      const res = createMockResponse();

      mockCollectionRef.get.mockRejectedValue(new Error('Database error'));

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getData()).toContain('Internal error');
    });

    it('should handle unknown event types gracefully', async () => {
      const event = { event: 'unknown.event', data: {} };
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createWebhookRequest(event, signature, allowedIps[0]);
      const res = createMockResponse();

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(200);
      expect(res._getData()).toContain('Webhook processed');
    });
  });

  describe('IP forwarding', () => {
    it('should handle single forwarded IP', async () => {
      const event = buildChargeSuccessEvent();
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createMockRequest({
        method: 'POST',
        body: event,
        headers: {
          'x-paystack-signature': signature,
          'x-forwarded-for': '52.31.139.75',
        },
      });
      const res = createMockResponse();

      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([{ id: 'donation-1', data: { donorUid: 'test' } }])
      );

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(200);
    });

    it('should handle multiple forwarded IPs (use first)', async () => {
      const event = buildChargeSuccessEvent();
      const signature = generatePaystackSignature(event, paystackSecret);
      const req = createMockRequest({
        method: 'POST',
        body: event,
        headers: {
          'x-paystack-signature': signature,
          'x-forwarded-for': '52.31.139.75, 10.0.0.1, 192.168.1.1',
        },
      });
      const res = createMockResponse();

      mockCollectionRef.get.mockResolvedValue(
        createMockQuerySnapshot([{ id: 'donation-1', data: { donorUid: 'test' } }])
      );

      await paystackWebhook(req, res);

      expect(res.statusCode).toBe(200);
    });
  });
});
