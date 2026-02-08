// Brevo (SendinBlue) Email API Mock

export interface MockEmailParams {
  to: Array<{ email: string; name?: string }>;
  subject: string;
  htmlContent?: string;
  textContent?: string;
  templateId?: number;
  params?: Record<string, any>;
}

export interface MockEmailResponse {
  messageId: string;
  success: boolean;
}

// Track sent emails for assertions
export const sentEmails: MockEmailParams[] = [];

// Mock TransactionalEmailsApi
export const mockTransactionalEmailsApi = {
  sendTransacEmail: jest.fn().mockImplementation((emailParams: MockEmailParams): Promise<MockEmailResponse> => {
    sentEmails.push(emailParams);
    return Promise.resolve({
      messageId: `mock-message-${Date.now()}`,
      success: true,
    });
  }),
};

// Mock ContactsApi
export const mockContactsApi = {
  createContact: jest.fn().mockResolvedValue({ id: 'mock-contact-id' }),
  updateContact: jest.fn().mockResolvedValue(undefined),
  deleteContact: jest.fn().mockResolvedValue(undefined),
  getContactInfo: jest.fn().mockResolvedValue({
    id: 'mock-contact-id',
    email: 'test@example.com',
    attributes: {},
  }),
};

// Mock ApiClient
export const mockApiClient = {
  instance: {
    authentications: {
      'api-key': {
        apiKey: 'mock-api-key',
      },
    },
  },
};

// Apply the mock to sib-api-v3-sdk
jest.mock('sib-api-v3-sdk', () => ({
  ApiClient: {
    instance: mockApiClient.instance,
  },
  TransactionalEmailsApi: jest.fn().mockImplementation(() => mockTransactionalEmailsApi),
  ContactsApi: jest.fn().mockImplementation(() => mockContactsApi),
  SendSmtpEmail: jest.fn().mockImplementation(() => ({})),
}));

// Helper functions for tests
export const clearSentEmails = () => {
  sentEmails.length = 0;
};

export const getLastSentEmail = (): MockEmailParams | undefined => {
  return sentEmails[sentEmails.length - 1];
};

export const getSentEmailsTo = (email: string): MockEmailParams[] => {
  return sentEmails.filter((e) => e.to.some((recipient) => recipient.email === email));
};

export const assertEmailSent = (to: string, subject?: string) => {
  const emailsToRecipient = getSentEmailsTo(to);
  expect(emailsToRecipient.length).toBeGreaterThan(0);
  if (subject) {
    expect(emailsToRecipient.some((e) => e.subject === subject)).toBe(true);
  }
};

export const assertNoEmailsSent = () => {
  expect(sentEmails.length).toBe(0);
};

// Mock email failure
export const mockEmailFailure = (errorMessage = 'Email sending failed') => {
  mockTransactionalEmailsApi.sendTransacEmail.mockRejectedValueOnce(new Error(errorMessage));
};

// Reset all mocks
export const resetBrevoMocks = () => {
  clearSentEmails();
  mockTransactionalEmailsApi.sendTransacEmail.mockClear();
  mockContactsApi.createContact.mockClear();
  mockContactsApi.updateContact.mockClear();
  mockContactsApi.deleteContact.mockClear();
  mockContactsApi.getContactInfo.mockClear();
};
