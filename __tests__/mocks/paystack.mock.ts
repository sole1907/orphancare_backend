// Paystack API Mock

export interface MockPaystackResponse {
  status: boolean;
  message: string;
  data?: any;
}

// Default successful responses
export const mockPaystackResponses = {
  initializeTransaction: {
    status: true,
    message: 'Authorization URL created',
    data: {
      authorization_url: 'https://checkout.paystack.com/mock-checkout',
      access_code: 'mock_access_code',
      reference: 'mock_ref_123',
    },
  },
  chargeAuthorization: {
    status: true,
    message: 'Charge attempted',
    data: {
      reference: 'mock_charge_ref',
      status: 'success',
      amount: 560000,
    },
  },
  verifyTransaction: {
    status: true,
    message: 'Verification successful',
    data: {
      status: 'success',
      reference: 'mock_ref_123',
      amount: 560000,
      customer: {
        email: 'donor@example.com',
      },
    },
  },
  listBanks: {
    status: true,
    message: 'Banks retrieved',
    data: [
      { id: 1, name: 'Access Bank', code: '044', slug: 'access-bank' },
      { id: 2, name: 'GTBank', code: '058', slug: 'gtbank' },
    ],
  },
  resolveAccount: {
    status: true,
    message: 'Account number resolved',
    data: {
      account_number: '0001234567',
      account_name: 'Test Account Name',
      bank_id: 1,
    },
  },
  createSubaccount: {
    status: true,
    message: 'Subaccount created',
    data: {
      subaccount_code: 'ACCT_mock123',
      business_name: 'Test Business',
      settlement_bank: 'Access Bank',
      account_number: '0001234567',
    },
  },
};

// Mock fetch for Paystack API calls
export const createPaystackFetchMock = (customResponses: Partial<typeof mockPaystackResponses> = {}) => {
  const responses = { ...mockPaystackResponses, ...customResponses };

  return jest.fn().mockImplementation((url: string, options?: RequestInit) => {
    const urlStr = url.toString();

    // Determine which endpoint is being called
    let responseData: MockPaystackResponse;

    if (urlStr.includes('/transaction/initialize')) {
      responseData = responses.initializeTransaction;
    } else if (urlStr.includes('/transaction/charge_authorization')) {
      responseData = responses.chargeAuthorization;
    } else if (urlStr.includes('/transaction/verify')) {
      responseData = responses.verifyTransaction;
    } else if (urlStr.includes('/bank') && urlStr.includes('resolve')) {
      responseData = responses.resolveAccount;
    } else if (urlStr.includes('/bank')) {
      responseData = responses.listBanks;
    } else if (urlStr.includes('/subaccount')) {
      responseData = responses.createSubaccount;
    } else {
      responseData = { status: true, message: 'OK' };
    }

    return Promise.resolve({
      ok: responseData.status,
      status: responseData.status ? 200 : 400,
      text: () => Promise.resolve(JSON.stringify(responseData)),
      json: () => Promise.resolve(responseData),
    });
  });
};

// Mock failed Paystack responses
export const mockPaystackFailures = {
  initializeTransaction: {
    status: false,
    message: 'Invalid email address',
    data: null,
  },
  chargeAuthorization: {
    status: false,
    message: 'Card authorization failed',
    data: null,
  },
  verifyTransaction: {
    status: true,
    message: 'Verification successful',
    data: {
      status: 'failed',
      reference: 'mock_ref_123',
      gateway_response: 'Insufficient Funds',
    },
  },
};

// Create a mock that simulates network failure
export const createNetworkFailureMock = () => {
  return jest.fn().mockRejectedValue(new Error('Network error: Unable to connect to Paystack'));
};

// Paystack webhook event builders
export const buildChargeSuccessEvent = (overrides: Partial<{
  reference: string;
  amount: number;
  email: string;
  authorizationCode: string;
  reusable: boolean;
  planCode?: string;
  recurring?: boolean;
  donorUid?: string;
  childId?: string;
  orphanageId?: string;
}> = {}) => {
  return {
    event: 'charge.success',
    data: {
      reference: overrides.reference || 'ref_' + Date.now(),
      amount: overrides.amount || 560000,
      customer: {
        email: overrides.email || 'donor@example.com',
      },
      authorization: {
        authorization_code: overrides.authorizationCode || 'AUTH_mock123',
        reusable: overrides.reusable ?? true,
      },
      metadata: {
        donorUid: overrides.donorUid || 'test-donor-id',
        childId: overrides.childId || 'test-child-id',
        orphanageId: overrides.orphanageId || 'test-orphanage-id',
        planCode: overrides.planCode,
        recurring: overrides.recurring || false,
      },
    },
  };
};

export const buildChargeFailedEvent = (overrides: Partial<{
  reference: string;
  amount: number;
  email: string;
  gatewayResponse: string;
}> = {}) => {
  return {
    event: 'charge.failed',
    data: {
      reference: overrides.reference || 'ref_' + Date.now(),
      amount: overrides.amount || 560000,
      customer: {
        email: overrides.email || 'donor@example.com',
      },
      gateway_response: overrides.gatewayResponse || 'Insufficient Funds',
    },
  };
};

// Apply the mock to node-fetch
export const applyPaystackMock = (customResponses?: Partial<typeof mockPaystackResponses>) => {
  const mockFetch = createPaystackFetchMock(customResponses);
  jest.mock('node-fetch', () => mockFetch);
  return mockFetch;
};
