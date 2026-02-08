// Test fixtures for donors

export interface DonorFixture {
  uid: string;
  email: string;
  name: string;
  phone?: string;
  lifetimeDonations: number;
  lifetimeDonationCount: number;
  lastDonationAt?: Date;
  createdAt: Date;
  verified?: boolean;
}

export const testDonors: Record<string, DonorFixture> = {
  regular: {
    uid: 'donor-regular-001',
    email: 'regular.donor@example.com',
    name: 'Regular Donor',
    phone: '+2341234567890',
    lifetimeDonations: 50000,
    lifetimeDonationCount: 5,
    lastDonationAt: new Date('2024-01-10'),
    createdAt: new Date('2023-06-15'),
    verified: true,
  },
  new: {
    uid: 'donor-new-001',
    email: 'new.donor@example.com',
    name: 'New Donor',
    lifetimeDonations: 0,
    lifetimeDonationCount: 0,
    createdAt: new Date('2024-01-14'),
    verified: false,
  },
  vip: {
    uid: 'donor-vip-001',
    email: 'vip.donor@example.com',
    name: 'VIP Donor',
    phone: '+2349876543210',
    lifetimeDonations: 500000,
    lifetimeDonationCount: 25,
    lastDonationAt: new Date('2024-01-14'),
    createdAt: new Date('2022-01-01'),
    verified: true,
  },
  recurring: {
    uid: 'donor-recurring-001',
    email: 'recurring.donor@example.com',
    name: 'Recurring Donor',
    phone: '+2348001234567',
    lifetimeDonations: 120000,
    lifetimeDonationCount: 12,
    lastDonationAt: new Date('2024-01-01'),
    createdAt: new Date('2023-01-01'),
    verified: true,
  },
};

export function createDonorFixture(overrides: Partial<DonorFixture> = {}): DonorFixture {
  return {
    uid: `donor-${Date.now()}`,
    email: `donor.${Date.now()}@example.com`,
    name: 'Test Donor',
    lifetimeDonations: 0,
    lifetimeDonationCount: 0,
    createdAt: new Date(),
    ...overrides,
  };
}
