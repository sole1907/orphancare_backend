// Jest global setup for OrphanCare Firebase Functions tests

// Set test environment
process.env.NODE_ENV = 'test';
process.env.GCLOUD_PROJECT = 'orphancare-test';
process.env.GCP_PROJECT = 'orphancare-test';
process.env.PAYSTACK_URI = 'https://api.paystack.co';
process.env.ENV_TYPE = 'development';
process.env.FUNCTION_VERSION = '1.0.0-test';

// Import and apply mocks before any tests run
import './firebaseMocks';
import './secretMocks';

// Global test timeout
jest.setTimeout(10000);

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
});

// Global error handler for unhandled promise rejections in tests
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection in test:', reason);
});
