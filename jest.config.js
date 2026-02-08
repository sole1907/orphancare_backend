module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup/jest.setup.ts'],

  // Module resolution
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/functions/src/$1',
  },

  // Coverage settings
  collectCoverage: true,
  collectCoverageFrom: [
    'functions/src/**/*.ts',
    '!functions/src/**/*.d.ts',
    '!functions/src/types/**',
    '!functions/src/index.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html', 'json-summary'],

  // 90% coverage threshold (target - will be increased as more tests are added)
  // TODO: Increase thresholds as coverage improves
  coverageThreshold: {
    global: {
      branches: 20,
      functions: 20,
      lines: 20,
      statements: 20,
    },
  },

  // JUnit reporter for CI
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: 'test-results',
      outputName: 'junit.xml',
    }],
  ],

  // Transform settings
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
    }],
  },

  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
  verbose: true,

  // Timeout for async operations
  testTimeout: 10000,
};
