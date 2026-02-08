// Tests for feeEngine.ts

import { FeeConfig, computePaystackFee, computeGrossAmount } from '../../functions/src/lib/feeEngine';

describe('feeEngine', () => {
  const defaultConfig: FeeConfig = {
    percentage: 0.015, // 1.5%
    flatFee: 100, // NGN 100
    cap: 2000, // NGN 2000 cap
    vatPercentage: 0.075, // 7.5% VAT
    flatFeeWaiverThreshold: 2500, // Flat fee waived under NGN 2500
  };

  describe('computePaystackFee', () => {
    it('should compute fee correctly for amounts under flat fee waiver threshold', () => {
      // Amount: 2000 NGN (under 2500 threshold, so no flat fee)
      // Fee = 2000 * 0.015 * 1.075 = 32.25 -> ceil = 33
      const fee = computePaystackFee(2000, defaultConfig);
      expect(fee).toBe(33);
    });

    it('should include flat fee for amounts at or above threshold', () => {
      // Amount: 2500 NGN (at threshold, so flat fee applies)
      // Fee = (2500 * 0.015 + 100) * 1.075 = (37.5 + 100) * 1.075 = 147.8125 -> ceil = 148
      const fee = computePaystackFee(2500, defaultConfig);
      expect(fee).toBe(148);
    });

    it('should include flat fee for amounts above threshold', () => {
      // Amount: 5000 NGN
      // Fee = (5000 * 0.015 + 100) * 1.075 = (75 + 100) * 1.075 = 188.125 -> ceil = 189
      const fee = computePaystackFee(5000, defaultConfig);
      expect(fee).toBe(189);
    });

    it('should cap the fee at maximum', () => {
      // Amount: 200000 NGN
      // Fee = (200000 * 0.015 + 100) * 1.075 = (3000 + 100) * 1.075 = 3332.5
      // But cap is 2000, so fee = 2000
      const fee = computePaystackFee(200000, defaultConfig);
      expect(fee).toBe(2000);
    });

    it('should return 0 for 0 amount', () => {
      const fee = computePaystackFee(0, defaultConfig);
      expect(fee).toBe(0);
    });

    it('should handle small amounts correctly', () => {
      // Amount: 100 NGN
      // Fee = 100 * 0.015 * 1.075 = 1.6125 -> ceil = 2
      const fee = computePaystackFee(100, defaultConfig);
      expect(fee).toBe(2);
    });

    it('should handle custom configs correctly', () => {
      const customConfig: FeeConfig = {
        percentage: 0.02, // 2%
        flatFee: 50,
        cap: 1000,
        vatPercentage: 0.05, // 5% VAT
        flatFeeWaiverThreshold: 1000,
      };

      // Amount: 2000 NGN (above threshold)
      // Fee = (2000 * 0.02 + 50) * 1.05 = (40 + 50) * 1.05 = 94.5 -> ceil = 95
      const fee = computePaystackFee(2000, customConfig);
      expect(fee).toBe(95);
    });

    it('should cap at configured maximum for high amounts', () => {
      const customConfig: FeeConfig = {
        ...defaultConfig,
        cap: 500,
      };

      // With cap of 500, any amount that would produce fee > 500 should return 500
      const fee = computePaystackFee(50000, customConfig);
      expect(fee).toBe(500);
    });
  });

  describe('computeGrossAmount', () => {
    it('should compute gross amount such that net + fee = gross', () => {
      const netAmount = 5000;
      const gross = computeGrossAmount(netAmount, defaultConfig);
      const fee = computePaystackFee(gross, defaultConfig);

      expect(gross).toBe(netAmount + fee);
    });

    it('should handle small amounts', () => {
      const netAmount = 1000;
      const gross = computeGrossAmount(netAmount, defaultConfig);
      const fee = computePaystackFee(gross, defaultConfig);

      expect(gross).toBe(netAmount + fee);
    });

    it('should handle amounts near flat fee threshold', () => {
      const netAmount = 2400;
      const gross = computeGrossAmount(netAmount, defaultConfig);
      const fee = computePaystackFee(gross, defaultConfig);

      expect(gross).toBe(netAmount + fee);
    });

    it('should handle large amounts where fee caps', () => {
      const netAmount = 200000;
      const gross = computeGrossAmount(netAmount, defaultConfig);
      const fee = computePaystackFee(gross, defaultConfig);

      expect(gross).toBe(netAmount + fee);
      expect(fee).toBe(2000); // Cap should be applied
    });

    it('should converge for various amounts', () => {
      const testAmounts = [100, 500, 1000, 2500, 5000, 10000, 50000, 100000];

      testAmounts.forEach((netAmount) => {
        const gross = computeGrossAmount(netAmount, defaultConfig);
        const fee = computePaystackFee(gross, defaultConfig);
        expect(gross).toBe(netAmount + fee);
      });
    });

    it('should work with custom config', () => {
      const customConfig: FeeConfig = {
        percentage: 0.02,
        flatFee: 150,
        cap: 1500,
        vatPercentage: 0.1,
        flatFeeWaiverThreshold: 3000,
      };

      const netAmount = 5000;
      const gross = computeGrossAmount(netAmount, customConfig);
      const fee = computePaystackFee(gross, customConfig);

      expect(gross).toBe(netAmount + fee);
    });
  });
});
