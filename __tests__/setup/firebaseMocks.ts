// Firebase Admin SDK Mocks

// Mock DocumentReference
export const mockDocRef = {
  id: 'mock-doc-id',
  update: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue(undefined),
  delete: jest.fn().mockResolvedValue(undefined),
  get: jest.fn().mockResolvedValue({
    exists: true,
    id: 'mock-doc-id',
    data: () => ({}),
    ref: { id: 'mock-doc-id' },
  }),
};

// Mock DocumentSnapshot
export const createMockDocSnapshot = (exists: boolean, data: any = {}, id = 'mock-doc-id') => ({
  exists,
  id,
  data: () => data,
  ref: { ...mockDocRef, id },
});

// Mock QuerySnapshot
export const createMockQuerySnapshot = (docs: any[] = []) => {
  const mappedDocs = docs.map((doc, index) => {
    const docId = doc.id || `doc-${index}`;
    const docRef = doc.ref || { ...mockDocRef, id: docId, update: jest.fn().mockResolvedValue(undefined) };
    return {
      id: docId,
      data: () => doc.data || doc,
      ref: docRef,
    };
  });

  return {
    empty: docs.length === 0,
    size: docs.length,
    docs: mappedDocs,
    forEach: (callback: (doc: any) => void) => {
      mappedDocs.forEach(callback);
    },
  };
};

// Mock collection reference
export const mockCollectionRef = {
  doc: jest.fn().mockReturnValue(mockDocRef),
  add: jest.fn().mockResolvedValue(mockDocRef),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  startAfter: jest.fn().mockReturnThis(),
  endBefore: jest.fn().mockReturnThis(),
  get: jest.fn().mockResolvedValue(createMockQuerySnapshot([])),
  count: jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue({ data: () => ({ count: 0 }) }),
  }),
};

// Mock Firestore
export const mockFirestore = {
  collection: jest.fn().mockReturnValue(mockCollectionRef),
  doc: jest.fn().mockReturnValue(mockDocRef),
  batch: jest.fn().mockReturnValue({
    update: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined),
  }),
  runTransaction: jest.fn(),
  getAll: jest.fn().mockResolvedValue([]),
};

// Mock Auth
export const mockAuth = {
  verifyIdToken: jest.fn().mockResolvedValue({
    uid: 'test-user-id',
    email: 'test@example.com',
  }),
  getUser: jest.fn().mockResolvedValue({
    uid: 'test-user-id',
    email: 'test@example.com',
    displayName: 'Test User',
  }),
  getUserByEmail: jest.fn().mockRejectedValue(new Error('User not found')),
  createUser: jest.fn().mockResolvedValue({ uid: 'new-user-id' }),
  updateUser: jest.fn().mockResolvedValue(undefined),
  deleteUser: jest.fn().mockResolvedValue(undefined),
  setCustomUserClaims: jest.fn().mockResolvedValue(undefined),
  generateEmailVerificationLink: jest.fn().mockResolvedValue('https://verify.example.com'),
  generatePasswordResetLink: jest.fn().mockResolvedValue('https://reset.example.com'),
};

// Mock Messaging
export const mockMessaging = {
  send: jest.fn().mockResolvedValue('message-id'),
  sendMulticast: jest.fn().mockResolvedValue({ successCount: 1, failureCount: 0 }),
};

// Mock FieldValue
export const mockFieldValue = {
  increment: jest.fn((n) => ({ _increment: n })),
  serverTimestamp: jest.fn(() => new Date()),
  arrayUnion: jest.fn((...elements) => ({ _arrayUnion: elements })),
  arrayRemove: jest.fn((...elements) => ({ _arrayRemove: elements })),
  delete: jest.fn(() => ({ _delete: true })),
};

// Apply mocks to firebase-admin
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  firestore: jest.fn(() => mockFirestore),
  auth: jest.fn(() => mockAuth),
  messaging: jest.fn(() => mockMessaging),
  credential: {
    applicationDefault: jest.fn(),
    cert: jest.fn(),
  },
}));

jest.mock('firebase-admin/app', () => ({
  getApps: jest.fn(() => []),
  initializeApp: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: mockFieldValue,
  Timestamp: {
    now: jest.fn(() => ({ toDate: () => new Date() })),
    fromDate: jest.fn((date) => ({ toDate: () => date })),
  },
}));

// Mock firebaseAdmin module used in the codebase
jest.mock('../../functions/src/lib/firebaseAdmin', () => ({
  db: mockFirestore,
  auth: mockAuth,
  messaging: mockMessaging,
  default: {
    initializeApp: jest.fn(),
    firestore: jest.fn(() => mockFirestore),
    auth: jest.fn(() => mockAuth),
    messaging: jest.fn(() => mockMessaging),
  },
}));

// Helper to reset all mocks
export const resetFirebaseMocks = () => {
  mockDocRef.update.mockClear();
  mockDocRef.set.mockClear();
  mockDocRef.delete.mockClear();
  mockDocRef.get.mockClear();
  mockCollectionRef.doc.mockClear();
  mockCollectionRef.add.mockClear();
  mockCollectionRef.where.mockClear();
  mockCollectionRef.orderBy.mockClear();
  mockCollectionRef.limit.mockClear();
  mockCollectionRef.get.mockClear();
  mockFirestore.collection.mockClear();
  mockAuth.verifyIdToken.mockClear();
  mockAuth.getUser.mockClear();
};

// Helper to set up Firestore mock responses
export const setupFirestoreMock = (
  collectionName: string,
  docId: string | null,
  response: { exists: boolean; data?: any }
) => {
  const docSnapshot = createMockDocSnapshot(response.exists, response.data, docId || 'mock-id');

  if (docId) {
    mockCollectionRef.doc.mockImplementation((id) => {
      if (id === docId) {
        return {
          ...mockDocRef,
          id: docId,
          get: jest.fn().mockResolvedValue(docSnapshot),
        };
      }
      return mockDocRef;
    });
  }

  mockFirestore.collection.mockImplementation((name) => {
    if (name === collectionName) {
      return mockCollectionRef;
    }
    return mockCollectionRef;
  });
};
