// Tests for calculateDonationFee.ts

jest.mock('firebase-functions/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('firebase-functions/v2/https', () => ({
  onRequest: jest.fn((options, handler) => handler),
}));

// Mock feeEngine
const mockLoadFeeConfig = jest.fn();
const mockComputeGrossAmount = jest.fn();
jest.mock('../../functions/src/lib/feeEngine', () => ({
  loadFeeConfig: mockLoadFeeConfig,
  computeGrossAmount: mockComputeGrossAmount,
}));

import { createMockRequest, createMockResponse } from '../setup/testHelpers';
import { calculateDonationFee } from '../../functions/src/calculateDonationFee';

describe('calculateDonationFee', () => {
  const defaultFeeConfig = {
    percentage: 0.015,
    flatFee: 100,
    cap: 2000,
    vatPercentage: 0.075,
    flatFeeWaiverThreshold: 2500,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadFeeConfig.mockResolvedValue(defaultFeeConfig);
  });

  describe('validation', () => {
    it('should reject missing baseAmount', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { tipPercent: 0.1 },
      });
      const res = createMockResponse();

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Invalid baseAmount');
    });

    it('should reject zero baseAmount', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: 0, tipPercent: 0.1 },
      });
      const res = createMockResponse();

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Invalid baseAmount');
    });

    it('should reject negative baseAmount', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: -1000, tipPercent: 0.1 },
      });
      const res = createMockResponse();

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Invalid baseAmount');
    });

    it('should reject non-numeric baseAmount', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: 'not-a-number', tipPercent: 0.1 },
      });
      const res = createMockResponse();

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Invalid baseAmount');
    });

    it('should reject missing tipPercent', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: 5000 },
      });
      const res = createMockResponse();

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Invalid tipPercent');
    });

    it('should reject negative tipPercent', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: 5000, tipPercent: -0.1 },
      });
      const res = createMockResponse();

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(400);
      expect(res._getData()).toContain('Invalid tipPercent');
    });
  });

  describe('fee calculation', () => {
    it('should calculate fees with tip', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: 5000, tipPercent: 0.1 },
      });
      const res = createMockResponse();

      // tipAmount = 5000 * 0.1 = 500
      // netAmount = 5000 + 500 = 5500
      mockComputeGrossAmount.mockReturnValue(5600);

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data).toEqual({
        baseAmount: 5000,
        tipAmount: 500,
        netAmount: 5500,
        paystackFee: 100,
        grossAmount: 5600,
      });
    });

    it('should calculate fees without tip', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: 10000, tipPercent: 0 },
      });
      const res = createMockResponse();

      mockComputeGrossAmount.mockReturnValue(10154);

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data).toEqual({
        baseAmount: 10000,
        tipAmount: 0,
        netAmount: 10000,
        paystackFee: 154,
        grossAmount: 10154,
      });
    });

    it('should load fee config from database', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: 5000, tipPercent: 0.1 },
      });
      const res = createMockResponse();

      mockComputeGrossAmount.mockReturnValue(5600);

      await calculateDonationFee(req, res);

      expect(mockLoadFeeConfig).toHaveBeenCalled();
      expect(mockComputeGrossAmount).toHaveBeenCalledWith(5500, defaultFeeConfig);
    });

    it('should round tip amount to integer', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: 3333, tipPercent: 0.1 },
      });
      const res = createMockResponse();

      // tipAmount = 3333 * 0.1 = 333.3 -> Math.round = 333
      // netAmount = 3333 + 333 = 3666
      mockComputeGrossAmount.mockReturnValue(3750);

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.tipAmount).toBe(333);
      expect(data.netAmount).toBe(3666);
    });
  });

  describe('error handling', () => {
    it('should return 500 on fee config load error', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: 5000, tipPercent: 0.1 },
      });
      const res = createMockResponse();

      mockLoadFeeConfig.mockRejectedValue(new Error('Database error'));

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getData()).toContain('Internal error');
    });

    it('should return 500 on computation error', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { baseAmount: 5000, tipPercent: 0.1 },
      });
      const res = createMockResponse();

      mockComputeGrossAmount.mockImplementation(() => {
        throw new Error('Computation failed');
      });

      await calculateDonationFee(req, res);

      expect(res.statusCode).toBe(500);
      expect(res._getData()).toContain('Internal error');
    });
  });
});
