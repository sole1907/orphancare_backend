// Firebase Functions defineSecret mocks

// Mock secret values for testing
export const mockSecretValues = {
  PAYSTACK_SECRET_KEY: 'sk_test_mock_paystack_secret',
  DEV_ENCRYPTION_KEY: 'test-encryption-key-32-chars-long',
  BLIND_INDEX_SALT: 'test-blind-index-salt',
  ADMIN_HEALTH_KEY: 'test-admin-health-key',
};

// Create a mock secret object
const createMockSecret = (name: string) => ({
  name,
  value: jest.fn(() => mockSecretValues[name as keyof typeof mockSecretValues] || `mock-${name}`),
});

// Mock defineSecret
jest.mock('firebase-functions/params', () => ({
  defineSecret: jest.fn((name: string) => createMockSecret(name)),
  defineString: jest.fn((name: string) => ({
    name,
    value: jest.fn(() => `mock-${name}`),
  })),
  defineInt: jest.fn((name: string) => ({
    name,
    value: jest.fn(() => 0),
  })),
  defineBoolean: jest.fn((name: string) => ({
    name,
    value: jest.fn(() => false),
  })),
}));

// Export mock secrets for direct use in tests
export const mockPaystackSecret = createMockSecret('PAYSTACK_SECRET_KEY');
export const mockDevEncryptionKey = createMockSecret('DEV_ENCRYPTION_KEY');
export const mockBlindIndexSalt = createMockSecret('BLIND_INDEX_SALT');

// Helper to update secret values for specific tests
export const setMockSecretValue = (secretName: string, value: string) => {
  mockSecretValues[secretName as keyof typeof mockSecretValues] = value as any;
};
