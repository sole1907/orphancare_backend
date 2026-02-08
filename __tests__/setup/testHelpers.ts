// Test helper utilities for OrphanCare Firebase Functions

import { Request, Response } from 'express';
import { createRequest, createResponse, MockRequest, MockResponse, RequestMethod } from 'node-mocks-http';

/**
 * Create a mock Express request compatible with Firebase Functions
 */
export function createMockRequest(options: {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  params?: Record<string, string>;
} = {}): MockRequest<Request> & { rawBody: Buffer } {
  const req = createRequest({
    method: (options.method || 'POST') as RequestMethod,
    body: options.body || {},
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
    query: options.query || {},
    params: options.params || {},
  });

  // Add rawBody for Firebase Functions compatibility
  (req as any).rawBody = Buffer.from(JSON.stringify(options.body || {}));

  return req as MockRequest<Request> & { rawBody: Buffer };
}

/**
 * Create a mock Express response
 */
export function createMockResponse(): MockResponse<Response> {
  return createResponse();
}

/**
 * Create a mock authenticated request with Bearer token
 */
export function createAuthenticatedRequest(
  body: any = {},
  userId = 'test-user-id',
  additionalHeaders: Record<string, string> = {}
): MockRequest<Request> & { rawBody: Buffer } {
  return createMockRequest({
    method: 'POST',
    body,
    headers: {
      authorization: `Bearer mock-token-for-${userId}`,
      ...additionalHeaders,
    },
  });
}

/**
 * Create a mock Paystack webhook request
 */
export function createWebhookRequest(
  event: any,
  signature: string,
  sourceIp = '52.31.139.75'
): MockRequest<Request> & { rawBody: Buffer } {
  return createMockRequest({
    method: 'POST',
    body: event,
    headers: {
      'x-paystack-signature': signature,
      'x-forwarded-for': sourceIp,
      'content-type': 'application/json',
    },
  });
}

/**
 * Create a mock CORS preflight request
 */
export function createPreflightRequest(origin: string): MockRequest<Request> & { rawBody: Buffer } {
  return createMockRequest({
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization',
    },
  });
}

/**
 * Generate a mock Paystack signature for webhook testing
 */
export function generatePaystackSignature(payload: any, secret: string): string {
  const crypto = require('crypto');
  return crypto
    .createHmac('sha512', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * Wait for a specified time (for async operations in tests)
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create test fee configuration
 */
export function createTestFeeConfig() {
  return {
    percentage: 0.015,
    flatFee: 100,
    cap: 2000,
    vatPercentage: 0.075,
    flatFeeWaiverThreshold: 2500,
  };
}

/**
 * Create test donor data
 */
export function createTestDonor(overrides: Partial<{
  uid: string;
  email: string;
  name: string;
  phone: string;
  lifetimeDonations: number;
  lifetimeDonationCount: number;
}> = {}) {
  return {
    uid: 'test-donor-id',
    email: 'donor@example.com',
    name: 'Test Donor',
    phone: '+2341234567890',
    lifetimeDonations: 0,
    lifetimeDonationCount: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Create test orphanage data
 */
export function createTestOrphanage(overrides: Partial<{
  id: string;
  name: string;
  subaccountCode: string;
  status: string;
}> = {}) {
  return {
    id: 'test-orphanage-id',
    name: 'Test Orphanage',
    subaccountCode: 'ACCT_test123',
    status: 'approved',
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Create test donation data
 */
export function createTestDonation(overrides: Partial<{
  id: string;
  donorUid: string;
  orphanageId: string;
  childId: string;
  baseAmount: number;
  tipPercent: number;
  status: string;
  recurring: boolean;
}> = {}) {
  return {
    id: 'test-donation-id',
    donorUid: 'test-donor-id',
    orphanageId: 'test-orphanage-id',
    childId: 'test-child-id',
    baseAmount: 5000,
    tipPercent: 0.1,
    tipAmount: 500,
    netAmount: 5500,
    grossAmount: 5600,
    paystackFee: 100,
    status: 'pending',
    recurring: false,
    interval: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Create test recurring plan data
 */
export function createTestRecurringPlan(overrides: Partial<{
  planCode: string;
  donorUid: string;
  orphanageId: string;
  childId: string;
  interval: string;
  status: string;
  baseAmount: number;
  nextChargeAt: Date;
  retryCount: number;
  maxRetries: number;
  authorizationCode_encrypted: any;
}> = {}): Record<string, any> {
  return {
    planCode: 'RC_test_123',
    donorUid: 'test-donor-id',
    orphanageId: 'test-orphanage-id',
    childId: 'test-child-id',
    interval: 'monthly',
    status: 'active',
    baseAmount: 5000,
    tipPercent: 0.1,
    tipAmount: 500,
    netAmount: 5500,
    grossAmount: 5600,
    orphanageAmount: 500000,
    platformAmount: 50000,
    customerEmail: 'donor@example.com',
    nextChargeAt: new Date(Date.now() - 86400000), // Yesterday (due for charge)
    createdAt: new Date(),
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

/**
 * Create test Paystack charge.success webhook event
 */
export function createPaystackChargeSuccessEvent(overrides: Partial<{
  reference: string;
  amount: number;
  email: string;
  authorization_code: string;
  reusable: boolean;
  metadata: any;
}> = {}) {
  const defaults = {
    reference: 'test-ref-123',
    amount: 560000,
    email: 'donor@example.com',
    authorization_code: 'AUTH_test123',
    reusable: true,
    metadata: {
      donorUid: 'test-donor-id',
      childId: 'test-child-id',
      orphanageId: 'test-orphanage-id',
      recurring: false,
    },
  };

  const merged = { ...defaults, ...overrides };

  return {
    event: 'charge.success',
    data: {
      reference: merged.reference,
      amount: merged.amount,
      customer: {
        email: merged.email,
      },
      authorization: {
        authorization_code: merged.authorization_code,
        reusable: merged.reusable,
      },
      metadata: merged.metadata,
    },
  };
}

/**
 * Assert that a response has the expected status and body
 */
export function assertResponse(
  res: MockResponse<Response>,
  expectedStatus: number,
  expectedBody?: any
) {
  expect(res.statusCode).toBe(expectedStatus);
  if (expectedBody !== undefined) {
    const actualBody = res._getData();
    if (typeof actualBody === 'string') {
      try {
        expect(JSON.parse(actualBody)).toEqual(expectedBody);
      } catch {
        expect(actualBody).toBe(expectedBody);
      }
    } else {
      expect(actualBody).toEqual(expectedBody);
    }
  }
}
