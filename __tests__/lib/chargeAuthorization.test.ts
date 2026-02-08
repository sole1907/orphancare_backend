// Tests for chargeAuthorization.ts

import { computeNextChargeAt } from '../../functions/src/lib/chargeAuthorization';

describe('chargeAuthorization', () => {
  describe('computeNextChargeAt', () => {
    const baseDate = new Date('2024-01-15T10:30:00Z');

    it('should compute next charge date for daily interval', () => {
      const nextCharge = computeNextChargeAt(baseDate, 'daily');

      expect(nextCharge.getUTCDate()).toBe(16);
      expect(nextCharge.getUTCMonth()).toBe(0); // January
      expect(nextCharge.getUTCFullYear()).toBe(2024);
      expect(nextCharge.getUTCHours()).toBe(0);
      expect(nextCharge.getUTCMinutes()).toBe(0);
      expect(nextCharge.getUTCSeconds()).toBe(0);
    });

    it('should compute next charge date for monthly interval', () => {
      const nextCharge = computeNextChargeAt(baseDate, 'monthly');

      expect(nextCharge.getUTCDate()).toBe(15);
      expect(nextCharge.getUTCMonth()).toBe(1); // February
      expect(nextCharge.getUTCFullYear()).toBe(2024);
    });

    it('should compute next charge date for quarterly interval', () => {
      const nextCharge = computeNextChargeAt(baseDate, 'quarterly');

      expect(nextCharge.getUTCDate()).toBe(15);
      expect(nextCharge.getUTCMonth()).toBe(3); // April
      expect(nextCharge.getUTCFullYear()).toBe(2024);
    });

    it('should compute next charge date for yearly interval', () => {
      const nextCharge = computeNextChargeAt(baseDate, 'yearly');

      expect(nextCharge.getUTCDate()).toBe(15);
      expect(nextCharge.getUTCMonth()).toBe(0); // January
      expect(nextCharge.getUTCFullYear()).toBe(2025);
    });

    it('should handle case-insensitive intervals', () => {
      const upperCase = computeNextChargeAt(baseDate, 'MONTHLY');
      const lowerCase = computeNextChargeAt(baseDate, 'monthly');
      const mixedCase = computeNextChargeAt(baseDate, 'Monthly');

      expect(upperCase.getTime()).toBe(lowerCase.getTime());
      expect(lowerCase.getTime()).toBe(mixedCase.getTime());
    });

    it('should throw error for unsupported interval', () => {
      expect(() => computeNextChargeAt(baseDate, 'weekly')).toThrow(
        'Unsupported interval: weekly'
      );
      expect(() => computeNextChargeAt(baseDate, 'invalid')).toThrow(
        'Unsupported interval: invalid'
      );
    });

    it('should normalize time to 00:00:00 UTC', () => {
      const dateWithTime = new Date('2024-01-15T23:59:59Z');
      const nextCharge = computeNextChargeAt(dateWithTime, 'daily');

      expect(nextCharge.getUTCHours()).toBe(0);
      expect(nextCharge.getUTCMinutes()).toBe(0);
      expect(nextCharge.getUTCSeconds()).toBe(0);
      expect(nextCharge.getUTCMilliseconds()).toBe(0);
    });

    it('should handle month overflow correctly', () => {
      // January 31 + 1 month = February 29 (or 28 in non-leap year)
      const jan31 = new Date('2024-01-31T10:00:00Z');
      const nextCharge = computeNextChargeAt(jan31, 'monthly');

      // JavaScript Date handles month overflow by rolling to next month
      // So Jan 31 + 1 month in a leap year gives March 2 (Feb has 29 days)
      expect(nextCharge.getUTCMonth()).toBe(2); // March (0-indexed)
      expect(nextCharge.getUTCDate()).toBe(2);
    });

    it('should handle year boundary for monthly interval', () => {
      const december = new Date('2024-12-15T10:00:00Z');
      const nextCharge = computeNextChargeAt(december, 'monthly');

      expect(nextCharge.getUTCMonth()).toBe(0); // January
      expect(nextCharge.getUTCFullYear()).toBe(2025);
    });

    it('should handle year boundary for quarterly interval', () => {
      const november = new Date('2024-11-15T10:00:00Z');
      const nextCharge = computeNextChargeAt(november, 'quarterly');

      expect(nextCharge.getUTCMonth()).toBe(1); // February
      expect(nextCharge.getUTCFullYear()).toBe(2025);
    });

    it('should not mutate the original date', () => {
      const originalDate = new Date('2024-01-15T10:30:00Z');
      const originalTime = originalDate.getTime();

      computeNextChargeAt(originalDate, 'monthly');

      expect(originalDate.getTime()).toBe(originalTime);
    });
  });
});
