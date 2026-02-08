// Tests for encryption.ts

import CryptoJS from 'crypto-js';

// Must mock before importing the module
jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn((name: string) => ({
    name,
    value: jest.fn(() => {
      if (name === 'DEV_ENCRYPTION_KEY') return 'test-encryption-key-32-chars-long';
      if (name === 'BLIND_INDEX_SALT') return 'test-blind-index-salt';
      return `mock-${name}`;
    }),
  })),
}));

jest.mock('@google-cloud/kms', () => ({
  KeyManagementServiceClient: jest.fn().mockImplementation(() => ({
    cryptoKeyPath: jest.fn().mockReturnValue('mock-key-path'),
    encrypt: jest.fn().mockResolvedValue([{ ciphertext: Buffer.from('encrypted') }]),
    decrypt: jest.fn().mockResolvedValue([{ plaintext: Buffer.from('decrypted') }]),
  })),
}));

// Import after mocks are set up
import {
  PIIFieldType,
  hashOTP,
  verifyOTP,
  createBlindIndex,
  encryptDeterministic,
} from '../../functions/src/lib/encryption';

describe('encryption', () => {
  beforeEach(() => {
    process.env.ENV_TYPE = 'development';
    process.env.GCP_PROJECT = 'orphancare-test';
  });

  describe('hashOTP', () => {
    it('should hash an OTP and return salt:hash format', () => {
      const otp = '123456';
      const hash = hashOTP(otp);

      expect(hash).toContain(':');
      const parts = hash.split(':');
      expect(parts.length).toBe(2);
      expect(parts[0].length).toBeGreaterThan(0); // Salt
      expect(parts[1].length).toBeGreaterThan(0); // Hash
    });

    it('should produce different hashes for same OTP (random salt)', () => {
      const otp = '123456';
      const hash1 = hashOTP(otp);
      const hash2 = hashOTP(otp);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce different hashes for different OTPs', () => {
      const hash1 = hashOTP('123456');
      const hash2 = hashOTP('654321');

      // Even the hash portions should differ
      const hashPart1 = hash1.split(':')[1];
      const hashPart2 = hash2.split(':')[1];
      expect(hashPart1).not.toBe(hashPart2);
    });
  });

  describe('verifyOTP', () => {
    it('should verify correct OTP against its hash', () => {
      const otp = '123456';
      const hash = hashOTP(otp);

      expect(verifyOTP(otp, hash)).toBe(true);
    });

    it('should reject incorrect OTP', () => {
      const otp = '123456';
      const hash = hashOTP(otp);

      expect(verifyOTP('654321', hash)).toBe(false);
    });

    it('should handle empty OTP', () => {
      const hash = hashOTP('123456');
      expect(verifyOTP('', hash)).toBe(false);
    });

    it('should return false for malformed hash', () => {
      expect(verifyOTP('123456', 'malformed-hash-no-colon')).toBe(false);
    });

    it('should return false for empty salt or hash', () => {
      expect(verifyOTP('123456', ':hash')).toBe(false);
      expect(verifyOTP('123456', 'salt:')).toBe(false);
      expect(verifyOTP('123456', ':')).toBe(false);
    });

    it('should verify OTPs of various lengths', () => {
      const otps = ['1234', '123456', '12345678', '000000'];

      otps.forEach((otp) => {
        const hash = hashOTP(otp);
        expect(verifyOTP(otp, hash)).toBe(true);
      });
    });
  });

  describe('createBlindIndex', () => {
    it('should create a blind index from a value', () => {
      const value = 'test@example.com';
      const index = createBlindIndex(value);

      expect(index).toBeDefined();
      expect(typeof index).toBe('string');
      expect(index.length).toBeGreaterThan(0);
    });

    it('should produce same index for same value', () => {
      const value = 'test@example.com';
      const index1 = createBlindIndex(value);
      const index2 = createBlindIndex(value);

      expect(index1).toBe(index2);
    });

    it('should normalize values (lowercase and trim)', () => {
      const index1 = createBlindIndex('Test@Example.com');
      const index2 = createBlindIndex('test@example.com');
      const index3 = createBlindIndex('  test@example.com  ');

      expect(index1).toBe(index2);
      expect(index2).toBe(index3);
    });

    it('should produce different indexes for different values', () => {
      const index1 = createBlindIndex('test1@example.com');
      const index2 = createBlindIndex('test2@example.com');

      expect(index1).not.toBe(index2);
    });
  });

  describe('encryptDeterministic', () => {
    it('should encrypt a value deterministically', () => {
      const value = 'sensitive-data';
      const encrypted = encryptDeterministic(value);

      expect(encrypted).toBeDefined();
      expect(typeof encrypted).toBe('string');
      expect(encrypted.length).toBeGreaterThan(0);
    });

    it('should produce same ciphertext for same plaintext', () => {
      const value = 'sensitive-data';
      const encrypted1 = encryptDeterministic(value);
      const encrypted2 = encryptDeterministic(value);

      expect(encrypted1).toBe(encrypted2);
    });

    it('should normalize values before encryption', () => {
      const encrypted1 = encryptDeterministic('Sensitive-Data');
      const encrypted2 = encryptDeterministic('sensitive-data');
      const encrypted3 = encryptDeterministic('  sensitive-data  ');

      expect(encrypted1).toBe(encrypted2);
      expect(encrypted2).toBe(encrypted3);
    });

    it('should produce different ciphertext for different plaintext', () => {
      const encrypted1 = encryptDeterministic('data-1');
      const encrypted2 = encryptDeterministic('data-2');

      expect(encrypted1).not.toBe(encrypted2);
    });
  });

  describe('PIIFieldType', () => {
    it('should have all expected field types', () => {
      expect(PIIFieldType.EMAIL).toBe('email');
      expect(PIIFieldType.PHONE).toBe('phone');
      expect(PIIFieldType.NAME).toBe('name');
      expect(PIIFieldType.AUTHORIZATION_CODE).toBe('auth_code');
      expect(PIIFieldType.BIRTHDAY).toBe('birthday');
      expect(PIIFieldType.SUBACCOUNT_CODE).toBe('subaccount_code');
    });
  });
});
