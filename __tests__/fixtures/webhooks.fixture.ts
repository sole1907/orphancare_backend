// Test fixtures for Paystack webhook events

export interface WebhookEventFixture {
  event: string;
  data: {
    reference: string;
    amount: number;
    customer: {
      email: string;
    };
    authorization?: {
      authorization_code: string;
      reusable: boolean;
      bank: string;
      last4: string;
      exp_month: string;
      exp_year: string;
      card_type: string;
    };
    metadata?: Record<string, any>;
    gateway_response?: string;
    status?: string;
  };
}

export const webhookEvents: Record<string, WebhookEventFixture> = {
  chargeSuccessOneOff: {
    event: 'charge.success',
    data: {
      reference: 'ref_oneoff_success_001',
      amount: 568900,
      customer: {
        email: 'donor@example.com',
      },
      authorization: {
        authorization_code: 'AUTH_oneoff_001',
        reusable: true,
        bank: 'GTBank',
        last4: '4081',
        exp_month: '12',
        exp_year: '2025',
        card_type: 'visa',
      },
      metadata: {
        donorUid: 'donor-regular-001',
        childId: 'child-001',
        orphanageId: 'orphanage-001',
        recurring: false,
      },
      status: 'success',
    },
  },
  chargeSuccessRecurringFirst: {
    event: 'charge.success',
    data: {
      reference: 'ref_recurring_first_001',
      amount: 568900,
      customer: {
        email: 'recurring.donor@example.com',
      },
      authorization: {
        authorization_code: 'AUTH_recurring_001',
        reusable: true,
        bank: 'Access Bank',
        last4: '1234',
        exp_month: '06',
        exp_year: '2026',
        card_type: 'mastercard',
      },
      metadata: {
        donorUid: 'donor-recurring-001',
        childId: 'child-003',
        orphanageId: 'orphanage-002',
        planCode: 'RC_test_001',
        recurring: true,
      },
      status: 'success',
    },
  },
  chargeSuccessRecurringSubsequent: {
    event: 'charge.success',
    data: {
      reference: 'ref_recurring_sub_001',
      amount: 568900,
      customer: {
        email: 'recurring.donor@example.com',
      },
      authorization: {
        authorization_code: 'AUTH_recurring_001',
        reusable: true,
        bank: 'Access Bank',
        last4: '1234',
        exp_month: '06',
        exp_year: '2026',
        card_type: 'mastercard',
      },
      metadata: {
        donorUid: 'donor-recurring-001',
        childId: 'child-003',
        orphanageId: 'orphanage-002',
        planCode: 'RC_test_001',
        recurring: true,
      },
      status: 'success',
    },
  },
  chargeSuccessNonReusable: {
    event: 'charge.success',
    data: {
      reference: 'ref_nonreusable_001',
      amount: 568900,
      customer: {
        email: 'donor@example.com',
      },
      authorization: {
        authorization_code: 'AUTH_nonreusable_001',
        reusable: false,
        bank: 'Zenith Bank',
        last4: '9999',
        exp_month: '03',
        exp_year: '2024',
        card_type: 'visa',
      },
      metadata: {
        donorUid: 'donor-regular-001',
        childId: 'child-001',
        orphanageId: 'orphanage-001',
        planCode: 'RC_nonreusable_001',
        recurring: true,
      },
      status: 'success',
    },
  },
  chargeFailed: {
    event: 'charge.failed',
    data: {
      reference: 'ref_failed_001',
      amount: 5692500,
      customer: {
        email: 'donor@example.com',
      },
      gateway_response: 'Insufficient Funds',
      status: 'failed',
    },
  },
  chargeFailedDeclined: {
    event: 'charge.failed',
    data: {
      reference: 'ref_declined_001',
      amount: 1000000,
      customer: {
        email: 'donor@example.com',
      },
      gateway_response: 'Transaction Declined',
      status: 'failed',
    },
  },
};

export function createChargeSuccessEvent(overrides: {
  reference?: string;
  amount?: number;
  email?: string;
  authorizationCode?: string;
  reusable?: boolean;
  donorUid?: string;
  childId?: string;
  orphanageId?: string;
  planCode?: string;
  recurring?: boolean;
} = {}): WebhookEventFixture {
  return {
    event: 'charge.success',
    data: {
      reference: overrides.reference || `ref_${Date.now()}`,
      amount: overrides.amount || 568900,
      customer: {
        email: overrides.email || 'donor@example.com',
      },
      authorization: {
        authorization_code: overrides.authorizationCode || `AUTH_${Date.now()}`,
        reusable: overrides.reusable ?? true,
        bank: 'Test Bank',
        last4: '0000',
        exp_month: '12',
        exp_year: '2030',
        card_type: 'visa',
      },
      metadata: {
        donorUid: overrides.donorUid || 'test-donor-id',
        childId: overrides.childId || 'test-child-id',
        orphanageId: overrides.orphanageId || 'test-orphanage-id',
        planCode: overrides.planCode,
        recurring: overrides.recurring || false,
      },
      status: 'success',
    },
  };
}

export function createChargeFailedEvent(overrides: {
  reference?: string;
  amount?: number;
  email?: string;
  gatewayResponse?: string;
} = {}): WebhookEventFixture {
  return {
    event: 'charge.failed',
    data: {
      reference: overrides.reference || `ref_failed_${Date.now()}`,
      amount: overrides.amount || 568900,
      customer: {
        email: overrides.email || 'donor@example.com',
      },
      gateway_response: overrides.gatewayResponse || 'Transaction Failed',
      status: 'failed',
    },
  };
}
