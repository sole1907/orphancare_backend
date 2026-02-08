// Tests for donationUtils.ts

import { computeDonationAmounts, DonationAmounts } from '../../functions/src/lib/donationUtils';

describe('donationUtils', () => {
  describe('computeDonationAmounts', () => {
    const defaultConfig = {
      feePercent: 0.015,
      flatFee: 100,
    };

    it('should compute amounts correctly for base donation with no tip', () => {
      const result = computeDonationAmounts(5000, 0, defaultConfig);

      expect(result.tipAmount).toBe(0);
      expect(result.netAmount).toBe(5000);
      expect(result.orphanageAmount).toBe(500000); // In kobo
      expect(result.platformAmount).toBe(0); // In kobo
    });

    it('should compute amounts correctly with 10% tip', () => {
      const result = computeDonationAmounts(5000, 0.1, defaultConfig);

      expect(result.tipAmount).toBe(500); // 10% of 5000
      expect(result.netAmount).toBe(5500); // base + tip
      expect(result.orphanageAmount).toBe(500000); // baseAmount in kobo
      expect(result.platformAmount).toBe(50000); // tipAmount in kobo
    });

    it('should compute amounts correctly with 15% tip', () => {
      const result = computeDonationAmounts(10000, 0.15, defaultConfig);

      expect(result.tipAmount).toBe(1500);
      expect(result.netAmount).toBe(11500);
      expect(result.orphanageAmount).toBe(1000000);
      expect(result.platformAmount).toBe(150000);
    });

    it('should compute gross amount including fees', () => {
      const result = computeDonationAmounts(5000, 0.1, defaultConfig);

      // grossAmount = netAmount + flatFee + netAmount * feePercent
      // = 5500 + 100 + 5500 * 0.015 = 5500 + 100 + 82.5 = 5682.5
      expect(result.grossAmount).toBe(5682.5);
      expect(result.paystackFee).toBe(182.5);
    });

    it('should round tip amount correctly', () => {
      // 333 * 0.1 = 33.3, should round to 33
      const result = computeDonationAmounts(333, 0.1, defaultConfig);
      expect(result.tipAmount).toBe(33);
    });

    it('should handle zero base amount', () => {
      const result = computeDonationAmounts(0, 0.1, defaultConfig);

      expect(result.tipAmount).toBe(0);
      expect(result.netAmount).toBe(0);
      expect(result.grossAmount).toBe(100); // Just flat fee
    });

    it('should handle custom fee config', () => {
      const customConfig = {
        feePercent: 0.02,
        flatFee: 50,
      };

      const result = computeDonationAmounts(1000, 0.1, customConfig);

      // tipAmount = 1000 * 0.1 = 100
      // netAmount = 1000 + 100 = 1100
      // grossAmount = 1100 + 50 + 1100 * 0.02 = 1100 + 50 + 22 = 1172
      expect(result.tipAmount).toBe(100);
      expect(result.netAmount).toBe(1100);
      expect(result.grossAmount).toBe(1172);
      expect(result.paystackFee).toBe(72);
    });

    it('should handle large amounts', () => {
      const result = computeDonationAmounts(1000000, 0.1, defaultConfig);

      expect(result.tipAmount).toBe(100000);
      expect(result.netAmount).toBe(1100000);
      expect(result.orphanageAmount).toBe(100000000); // 1M in kobo
      expect(result.platformAmount).toBe(10000000); // 100K in kobo
    });

    it('should handle small tip percentages', () => {
      const result = computeDonationAmounts(10000, 0.05, defaultConfig);

      expect(result.tipAmount).toBe(500);
      expect(result.netAmount).toBe(10500);
    });

    it('should return all required fields', () => {
      const result = computeDonationAmounts(5000, 0.1, defaultConfig);

      const expectedKeys: (keyof DonationAmounts)[] = [
        'tipAmount',
        'netAmount',
        'grossAmount',
        'paystackFee',
        'orphanageAmount',
        'platformAmount',
      ];

      expectedKeys.forEach((key) => {
        expect(result).toHaveProperty(key);
        expect(typeof result[key]).toBe('number');
      });
    });

    it('should compute fee correctly as gross minus net', () => {
      const result = computeDonationAmounts(5000, 0.1, defaultConfig);

      expect(result.paystackFee).toBe(result.grossAmount - result.netAmount);
    });
  });
});
