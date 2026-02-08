// Test fixtures for donations

export interface DonationFixture {
  id: string;
  donorUid: string;
  donorEmail: string;
  orphanageId: string;
  childId: string;
  baseAmount: number;
  tipPercent: number;
  tipAmount: number;
  netAmount: number;
  grossAmount: number;
  paystackFee: number;
  orphanageAmount: number;
  platformAmount: number;
  status: 'pending' | 'success' | 'failed' | 'abandoned';
  recurring: boolean;
  interval: string | null;
  paystackRef: string;
  createdAt: Date;
  updatedAt?: Date;
}

export const testDonations: Record<string, DonationFixture> = {
  oneOffPending: {
    id: 'donation-oneoff-pending-001',
    donorUid: 'donor-regular-001',
    donorEmail: 'regular.donor@example.com',
    orphanageId: 'orphanage-001',
    childId: 'child-001',
    baseAmount: 5000,
    tipPercent: 0.1,
    tipAmount: 500,
    netAmount: 5500,
    grossAmount: 5689,
    paystackFee: 189,
    orphanageAmount: 500000,
    platformAmount: 50000,
    status: 'pending',
    recurring: false,
    interval: null,
    paystackRef: 'ref_oneoff_pending_001',
    createdAt: new Date('2024-01-15T10:00:00Z'),
  },
  oneOffSuccess: {
    id: 'donation-oneoff-success-001',
    donorUid: 'donor-regular-001',
    donorEmail: 'regular.donor@example.com',
    orphanageId: 'orphanage-001',
    childId: 'child-002',
    baseAmount: 10000,
    tipPercent: 0.15,
    tipAmount: 1500,
    netAmount: 11500,
    grossAmount: 11697,
    paystackFee: 197,
    orphanageAmount: 1000000,
    platformAmount: 150000,
    status: 'success',
    recurring: false,
    interval: null,
    paystackRef: 'ref_oneoff_success_001',
    createdAt: new Date('2024-01-14T15:30:00Z'),
    updatedAt: new Date('2024-01-14T15:35:00Z'),
  },
  recurringPending: {
    id: 'donation-recurring-pending-001',
    donorUid: 'donor-recurring-001',
    donorEmail: 'recurring.donor@example.com',
    orphanageId: 'orphanage-002',
    childId: 'child-003',
    baseAmount: 5000,
    tipPercent: 0.1,
    tipAmount: 500,
    netAmount: 5500,
    grossAmount: 5689,
    paystackFee: 189,
    orphanageAmount: 500000,
    platformAmount: 50000,
    status: 'pending',
    recurring: true,
    interval: 'monthly',
    paystackRef: 'ref_recurring_pending_001',
    createdAt: new Date('2024-01-15T12:00:00Z'),
  },
  recurringSuccess: {
    id: 'donation-recurring-success-001',
    donorUid: 'donor-recurring-001',
    donorEmail: 'recurring.donor@example.com',
    orphanageId: 'orphanage-002',
    childId: 'child-003',
    baseAmount: 5000,
    tipPercent: 0.1,
    tipAmount: 500,
    netAmount: 5500,
    grossAmount: 5689,
    paystackFee: 189,
    orphanageAmount: 500000,
    platformAmount: 50000,
    status: 'success',
    recurring: true,
    interval: 'monthly',
    paystackRef: 'ref_recurring_success_001',
    createdAt: new Date('2024-01-01T12:00:00Z'),
    updatedAt: new Date('2024-01-01T12:05:00Z'),
  },
  failed: {
    id: 'donation-failed-001',
    donorUid: 'donor-regular-001',
    donorEmail: 'regular.donor@example.com',
    orphanageId: 'orphanage-001',
    childId: 'child-001',
    baseAmount: 50000,
    tipPercent: 0.1,
    tipAmount: 5000,
    netAmount: 55000,
    grossAmount: 56925,
    paystackFee: 1925,
    orphanageAmount: 5000000,
    platformAmount: 500000,
    status: 'failed',
    recurring: false,
    interval: null,
    paystackRef: 'ref_failed_001',
    createdAt: new Date('2024-01-13T09:00:00Z'),
    updatedAt: new Date('2024-01-13T09:02:00Z'),
  },
};

export function createDonationFixture(overrides: Partial<DonationFixture> = {}): DonationFixture {
  const id = `donation-${Date.now()}`;
  const baseAmount = overrides.baseAmount || 5000;
  const tipPercent = overrides.tipPercent || 0.1;
  const tipAmount = Math.round(baseAmount * tipPercent);
  const netAmount = baseAmount + tipAmount;

  return {
    id,
    donorUid: 'test-donor-id',
    donorEmail: 'test@example.com',
    orphanageId: 'test-orphanage-id',
    childId: 'test-child-id',
    baseAmount,
    tipPercent,
    tipAmount,
    netAmount,
    grossAmount: netAmount + 189,
    paystackFee: 189,
    orphanageAmount: baseAmount * 100,
    platformAmount: tipAmount * 100,
    status: 'pending',
    recurring: false,
    interval: null,
    paystackRef: `ref_${id}`,
    createdAt: new Date(),
    ...overrides,
  };
}
