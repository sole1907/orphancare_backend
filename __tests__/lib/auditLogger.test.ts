// Tests for auditLogger.ts

jest.mock('firebase-functions/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

import {
  mockFirestore,
  mockCollectionRef,
} from '../setup/firebaseMocks';

import {
  AuditLogger,
  AuditAction,
  AuditCategory,
  ResourceType,
  auditLogger,
  withAuditLogging,
} from '../../functions/src/lib/auditLogger';

describe('AuditLogger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollectionRef.add.mockResolvedValue({ id: 'audit-log-id' });
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = AuditLogger.getInstance();
      const instance2 = AuditLogger.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should export singleton as auditLogger', () => {
      expect(auditLogger).toBe(AuditLogger.getInstance());
    });
  });

  describe('log', () => {
    it('should write audit entry to firestore', async () => {
      await auditLogger.log({
        action: AuditAction.CREATE_ORPHANAGE,
        category: AuditCategory.TIER_1_CRITICAL,
        actorId: 'user-123',
        actorEmail: 'admin@example.com',
        actorRole: 'superAdmin',
        orphanageId: 'orphanage-123',
        resourceType: ResourceType.ORPHANAGE,
        resourceId: 'orphanage-123',
        details: { name: 'Test Orphanage' },
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        success: true,
        errorMessage: null,
      });

      expect(mockFirestore.collection).toHaveBeenCalledWith('audit_logs');
      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'create_orphanage',
          category: 'TIER_1_CRITICAL',
          actorId: 'user-123',
          actorEmail: 'admin@example.com',
          actorRole: 'superAdmin',
          resourceType: 'orphanage',
          resourceId: 'orphanage-123',
          success: true,
        })
      );
    });

    it('should add server timestamp', async () => {
      await auditLogger.log({
        action: AuditAction.LOGIN,
        category: AuditCategory.TIER_4_LOW,
        actorId: 'user-123',
        actorEmail: 'user@example.com',
        actorRole: 'donor',
        orphanageId: null,
        resourceType: ResourceType.USER,
        resourceId: 'user-123',
        details: {},
        ipAddress: '10.0.0.1',
        userAgent: 'TestAgent',
        success: true,
        errorMessage: null,
      });

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.anything(),
        })
      );
    });

    it('should not throw on firestore error', async () => {
      mockCollectionRef.add.mockRejectedValue(new Error('Firestore error'));

      // Should not throw
      await expect(
        auditLogger.log({
          action: AuditAction.LOGIN,
          category: AuditCategory.TIER_4_LOW,
          actorId: 'user-123',
          actorEmail: 'user@example.com',
          actorRole: 'donor',
          orphanageId: null,
          resourceType: ResourceType.USER,
          resourceId: 'user-123',
          details: {},
          ipAddress: '10.0.0.1',
          userAgent: 'TestAgent',
          success: true,
          errorMessage: null,
        })
      ).resolves.not.toThrow();
    });
  });

  describe('logWithRequest', () => {
    it('should extract IP from x-forwarded-for header', async () => {
      const mockRequest = {
        headers: {
          'x-forwarded-for': '1.2.3.4, 5.6.7.8',
          'user-agent': 'TestBrowser',
        },
      };

      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'user-123', email: 'user@example.com' },
        action: AuditAction.LOGIN,
        resourceType: ResourceType.USER,
        resourceId: 'user-123',
        details: {},
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '1.2.3.4',
        })
      );
    });

    it('should extract IP from array x-forwarded-for', async () => {
      const mockRequest = {
        headers: {
          'x-forwarded-for': ['1.2.3.4', '5.6.7.8'],
          'user-agent': 'TestBrowser',
        },
      };

      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'user-123', email: 'user@example.com' },
        action: AuditAction.LOGIN,
        resourceType: ResourceType.USER,
        resourceId: 'user-123',
        details: {},
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '1.2.3.4',
        })
      );
    });

    it('should fall back to req.ip', async () => {
      const mockRequest = {
        headers: {},
        ip: '192.168.1.100',
      };

      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'user-123', email: 'user@example.com' },
        action: AuditAction.LOGIN,
        resourceType: ResourceType.USER,
        resourceId: 'user-123',
        details: {},
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '192.168.1.100',
        })
      );
    });

    it('should extract role from auth token - superAdmin', async () => {
      const mockRequest = { headers: {} };

      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'admin-123', email: 'admin@example.com', superAdmin: true },
        action: AuditAction.APPROVE_BANK_ACCOUNT,
        resourceType: ResourceType.BANK,
        resourceId: 'bank-123',
        details: {},
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          actorRole: 'superAdmin',
        })
      );
    });

    it('should extract role from auth token - orphanageAdmin', async () => {
      const mockRequest = { headers: {} };

      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'admin-123', email: 'admin@example.com', orphanageAdmin: true },
        action: AuditAction.CREATE_CHILD,
        resourceType: ResourceType.CHILD,
        resourceId: 'child-123',
        details: {},
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          actorRole: 'orphanageAdmin',
        })
      );
    });

    it('should default to donor role', async () => {
      const mockRequest = { headers: {} };

      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'user-123', email: 'user@example.com' },
        action: AuditAction.LOGIN,
        resourceType: ResourceType.USER,
        resourceId: 'user-123',
        details: {},
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          actorRole: 'donor',
        })
      );
    });

    it('should sanitize PII fields in details', async () => {
      const mockRequest = { headers: {} };

      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'user-123', email: 'user@example.com' },
        action: AuditAction.SUBMIT_BANK_ACCOUNT,
        resourceType: ResourceType.BANK,
        resourceId: 'bank-123',
        details: {
          accountNumber: '1234567890',
          email: 'secret@example.com',
          bankName: 'Test Bank',
        },
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            accountNumber: '[REDACTED]',
            email: '[REDACTED]',
            bankName: 'Test Bank',
          }),
        })
      );
    });

    it('should sanitize nested PII fields', async () => {
      const mockRequest = { headers: {} };

      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'user-123', email: 'user@example.com' },
        action: AuditAction.CREATE_CHILD,
        resourceType: ResourceType.CHILD,
        resourceId: 'child-123',
        details: {
          nested: {
            email: 'nested@example.com',
            name: 'Test',
          },
        },
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            nested: expect.objectContaining({
              email: '[REDACTED]',
              name: 'Test',
            }),
          }),
        })
      );
    });

    it('should include error message on failure', async () => {
      const mockRequest = { headers: {} };

      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'user-123', email: 'user@example.com' },
        action: AuditAction.FAILED_ACTION,
        resourceType: ResourceType.DONATION,
        resourceId: 'donation-123',
        details: {},
        success: false,
        errorMessage: 'Payment failed',
      });

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'Payment failed',
        })
      );
    });

    it('should map action to correct category', async () => {
      const mockRequest = { headers: {} };

      // Tier 1 - Critical
      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'admin-123', email: 'admin@example.com', superAdmin: true },
        action: AuditAction.APPROVE_BANK_ACCOUNT,
        resourceType: ResourceType.BANK,
        resourceId: 'bank-123',
        details: {},
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenLastCalledWith(
        expect.objectContaining({
          category: 'TIER_1_CRITICAL',
        })
      );

      // Tier 2 - High
      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'admin-123', email: 'admin@example.com' },
        action: AuditAction.CREATE_CHILD,
        resourceType: ResourceType.CHILD,
        resourceId: 'child-123',
        details: {},
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenLastCalledWith(
        expect.objectContaining({
          category: 'TIER_2_HIGH',
        })
      );

      // Tier 3 - Medium
      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'user-123', email: 'user@example.com' },
        action: AuditAction.CREATE_UPDATE,
        resourceType: ResourceType.UPDATE,
        resourceId: 'update-123',
        details: {},
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenLastCalledWith(
        expect.objectContaining({
          category: 'TIER_3_MEDIUM',
        })
      );

      // Tier 4 - Low
      await auditLogger.logWithRequest({
        request: mockRequest,
        auth: { uid: 'user-123', email: 'user@example.com' },
        action: AuditAction.LOGIN,
        resourceType: ResourceType.USER,
        resourceId: 'user-123',
        details: {},
        success: true,
      });

      expect(mockCollectionRef.add).toHaveBeenLastCalledWith(
        expect.objectContaining({
          category: 'TIER_4_LOW',
        })
      );
    });
  });

  describe('withAuditLogging', () => {
    it('should log success on successful handler execution', async () => {
      const mockHandler = jest.fn().mockResolvedValue({ result: 'success' });
      const wrappedHandler = withAuditLogging(
        AuditAction.CREATE_ORPHANAGE,
        ResourceType.ORPHANAGE,
        (req) => req.body?.orphanageId || 'unknown',
        mockHandler
      );

      const req = { body: { orphanageId: 'orphanage-123' } };
      const context = { auth: { uid: 'admin-123', email: 'admin@example.com' } };

      const result = await wrappedHandler(req, context);

      expect(result).toEqual({ result: 'success' });
      expect(mockHandler).toHaveBeenCalledWith(req, context);
      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          resourceId: 'orphanage-123',
        })
      );
    });

    it('should log failure on handler error and rethrow', async () => {
      const mockHandler = jest.fn().mockRejectedValue(new Error('Handler failed'));
      const wrappedHandler = withAuditLogging(
        AuditAction.CREATE_ORPHANAGE,
        ResourceType.ORPHANAGE,
        (req) => req.body?.orphanageId || 'unknown',
        mockHandler
      );

      const req = { body: { orphanageId: 'orphanage-123' } };
      const context = { auth: { uid: 'admin-123', email: 'admin@example.com' } };

      await expect(wrappedHandler(req, context)).rejects.toThrow('Handler failed');

      expect(mockCollectionRef.add).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'Handler failed',
        })
      );
    });
  });
});

describe('AuditAction enum', () => {
  it('should have all tier 1 actions', () => {
    expect(AuditAction.APPROVE_BANK_ACCOUNT).toBe('approve_bank_account');
    expect(AuditAction.REJECT_BANK_ACCOUNT).toBe('reject_bank_account');
    expect(AuditAction.CREATE_ORPHANAGE).toBe('create_orphanage');
  });

  it('should have all tier 2 actions', () => {
    expect(AuditAction.UPDATE_ORPHANAGE).toBe('update_orphanage');
    expect(AuditAction.SUBMIT_BANK_ACCOUNT).toBe('submit_bank_account');
    expect(AuditAction.CREATE_CHILD).toBe('create_child');
    expect(AuditAction.UPDATE_CHILD).toBe('update_child');
    expect(AuditAction.DELETE_CHILD).toBe('delete_child');
  });

  it('should have all tier 3 actions', () => {
    expect(AuditAction.CREATE_UPDATE).toBe('create_update');
    expect(AuditAction.EDIT_UPDATE).toBe('edit_update');
    expect(AuditAction.DELETE_UPDATE).toBe('delete_update');
    expect(AuditAction.CREATE_HOBBY).toBe('create_hobby');
    expect(AuditAction.UPDATE_HOBBY).toBe('update_hobby');
    expect(AuditAction.DELETE_HOBBY).toBe('delete_hobby');
  });

  it('should have all tier 4 actions', () => {
    expect(AuditAction.LOGIN).toBe('login');
    expect(AuditAction.LOGOUT).toBe('logout');
    expect(AuditAction.FAILED_LOGIN).toBe('failed_login');
    expect(AuditAction.FAILED_ACTION).toBe('failed_action');
  });
});

describe('ResourceType enum', () => {
  it('should have all resource types', () => {
    expect(ResourceType.ORPHANAGE).toBe('orphanage');
    expect(ResourceType.CHILD).toBe('child');
    expect(ResourceType.DONOR).toBe('donor');
    expect(ResourceType.DONATION).toBe('donation');
    expect(ResourceType.UPDATE).toBe('update');
    expect(ResourceType.HOBBY).toBe('hobby');
    expect(ResourceType.FAQ).toBe('faq');
    expect(ResourceType.BANK).toBe('bank');
    expect(ResourceType.USER).toBe('user');
  });
});
