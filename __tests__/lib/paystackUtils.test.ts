// Tests for paystackUtils.ts

jest.mock('firebase-functions/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock node-fetch
const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

// Mock encryption
const mockDecryptPII = jest.fn();
jest.mock('../../functions/src/lib/encryption', () => ({
  decryptPII: mockDecryptPII,
}));

import { initPaystackTransaction, getSubaccountCode } from '../../functions/src/lib/paystackUtils';

describe('paystackUtils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initPaystackTransaction', () => {
    const defaultParams = {
      email: 'donor@example.com',
      amount: 560000, // 5600 NGN in kobo
      metadata: { donorUid: 'user-123', orphanageId: 'orphanage-123' },
      callbackUrl: 'https://example.com/callback',
      paystackSecretValue: 'sk_test_xxx',
      PAYSTACK_URI: 'https://api.paystack.co',
    };

    it('should initialize a basic transaction', async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              status: true,
              data: {
                authorization_url: 'https://checkout.paystack.com/xxx',
                reference: 'ref_123',
              },
            })
          ),
      });

      const result = await initPaystackTransaction(defaultParams);

      expect(result).toEqual({
        authorization_url: 'https://checkout.paystack.com/xxx',
        reference: 'ref_123',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.paystack.co/transaction/initialize',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer sk_test_xxx',
            'Content-Type': 'application/json',
          },
        })
      );
    });

    it('should include subaccount for split payments', async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              status: true,
              data: {
                authorization_url: 'https://checkout.paystack.com/xxx',
                reference: 'ref_123',
              },
            })
          ),
      });

      await initPaystackTransaction({
        ...defaultParams,
        subaccount: 'ACCT_xxx',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"subaccount":"ACCT_xxx"'),
        })
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"bearer":"subaccount"'),
        })
      );
    });

    it('should include transaction_charge when provided', async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              status: true,
              data: {
                authorization_url: 'https://checkout.paystack.com/xxx',
                reference: 'ref_123',
              },
            })
          ),
      });

      await initPaystackTransaction({
        ...defaultParams,
        subaccount: 'ACCT_xxx',
        transactionCharge: 50000, // 500 NGN platform fee
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"transaction_charge":50000'),
        })
      );
    });

    it('should include metadata in request', async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              status: true,
              data: {
                authorization_url: 'https://checkout.paystack.com/xxx',
                reference: 'ref_123',
              },
            })
          ),
      });

      await initPaystackTransaction({
        ...defaultParams,
        metadata: {
          donorUid: 'user-123',
          orphanageId: 'orphanage-123',
          childId: 'child-456',
          recurring: true,
        },
      });

      const callArgs = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);

      expect(body.metadata).toEqual({
        donorUid: 'user-123',
        orphanageId: 'orphanage-123',
        childId: 'child-456',
        recurring: true,
      });
    });

    it('should throw on Paystack API failure', async () => {
      mockFetch.mockResolvedValue({
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              status: false,
              message: 'Invalid amount',
              errors: { amount: 'Amount must be greater than 0' },
            })
          ),
      });

      await expect(initPaystackTransaction(defaultParams)).rejects.toThrow(
        'Invalid amount'
      );
    });

    it('should throw on invalid JSON response', async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('not json'),
      });

      await expect(initPaystackTransaction(defaultParams)).rejects.toThrow(
        'Invalid Paystack init response'
      );
    });

    it('should handle generic Paystack failure', async () => {
      mockFetch.mockResolvedValue({
        status: 500,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              status: false,
            })
          ),
      });

      await expect(initPaystackTransaction(defaultParams)).rejects.toThrow(
        'Paystack init failed'
      );
    });
  });

  describe('getSubaccountCode', () => {
    it('should prefer encrypted subaccount code', async () => {
      mockDecryptPII.mockResolvedValue('ACCT_decrypted');

      const orphanageData = {
        subaccountCode_encrypted: {
          ciphertext: 'encrypted-data',
          iv: 'iv-value',
          version: 1,
          keyId: 'dev-key',
        },
        subaccountCode: 'ACCT_legacy',
      };

      const result = await getSubaccountCode(orphanageData);

      expect(result).toBe('ACCT_decrypted');
      expect(mockDecryptPII).toHaveBeenCalledWith(
        orphanageData.subaccountCode_encrypted
      );
    });

    it('should fall back to legacy plain text subaccount', async () => {
      const orphanageData = {
        subaccountCode: 'ACCT_legacy',
      };

      const result = await getSubaccountCode(orphanageData);

      expect(result).toBe('ACCT_legacy');
      expect(mockDecryptPII).not.toHaveBeenCalled();
    });

    it('should return null if no subaccount configured', async () => {
      const orphanageData = {};

      const result = await getSubaccountCode(orphanageData);

      expect(result).toBeNull();
    });

    it('should return empty string if subaccount is empty', async () => {
      const orphanageData = {
        subaccountCode: '',
      };

      const result = await getSubaccountCode(orphanageData);

      // Empty string is falsy in the if check, so it returns null
      expect(result).toBeNull();
    });
  });
});
