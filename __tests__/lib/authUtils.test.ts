// Tests for authUtils.ts

import { mockAuth } from '../setup/firebaseMocks';

// Import after mocks are applied
import { verifyAuth, AuthCheckOptions } from '../../functions/src/lib/authUtils';
import { createMockRequest } from '../setup/testHelpers';

describe('authUtils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('verifyAuth', () => {
    it('should verify a valid token and return decoded token', async () => {
      const mockDecoded = {
        uid: 'test-user-id',
        email: 'test@example.com',
      };
      mockAuth.verifyIdToken.mockResolvedValue(mockDecoded);

      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });

      const result = await verifyAuth(req);

      expect(result).toEqual(mockDecoded);
      expect(mockAuth.verifyIdToken).toHaveBeenCalledWith('valid-token');
    });

    it('should throw 401 error when no authorization header', async () => {
      const req = createMockRequest({ headers: {} });

      await expect(verifyAuth(req)).rejects.toEqual({
        code: 401,
        message: 'Unauthorized: Missing token',
      });
    });

    it('should throw 401 error when authorization header is not Bearer', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Basic abc123' },
      });

      await expect(verifyAuth(req)).rejects.toEqual({
        code: 401,
        message: 'Unauthorized: Missing token',
      });
    });

    it('should throw 401 error when token is invalid', async () => {
      mockAuth.verifyIdToken.mockRejectedValue(new Error('Invalid token'));

      const req = createMockRequest({
        headers: { authorization: 'Bearer invalid-token' },
      });

      await expect(verifyAuth(req)).rejects.toEqual({
        code: 401,
        message: 'Unauthorized: Invalid token',
      });
    });

    describe('role checking', () => {
      it('should pass when user has required role', async () => {
        const mockDecoded = {
          uid: 'admin-user-id',
          email: 'admin@example.com',
          superAdmin: true,
        };
        mockAuth.verifyIdToken.mockResolvedValue(mockDecoded);

        const req = createMockRequest({
          headers: { authorization: 'Bearer admin-token' },
        });

        const options: AuthCheckOptions = { requiredRoles: ['superAdmin'] };
        const result = await verifyAuth(req, options);

        expect(result).toEqual(mockDecoded);
      });

      it('should pass when user has one of multiple required roles', async () => {
        const mockDecoded = {
          uid: 'admin-user-id',
          email: 'admin@example.com',
          orphanageAdmin: true,
        };
        mockAuth.verifyIdToken.mockResolvedValue(mockDecoded);

        const req = createMockRequest({
          headers: { authorization: 'Bearer admin-token' },
        });

        const options: AuthCheckOptions = { requiredRoles: ['superAdmin', 'orphanageAdmin'] };
        const result = await verifyAuth(req, options);

        expect(result).toEqual(mockDecoded);
      });

      it('should throw 403 error when user lacks required role', async () => {
        const mockDecoded = {
          uid: 'regular-user-id',
          email: 'user@example.com',
        };
        mockAuth.verifyIdToken.mockResolvedValue(mockDecoded);

        const req = createMockRequest({
          headers: { authorization: 'Bearer user-token' },
        });

        const options: AuthCheckOptions = { requiredRoles: ['superAdmin'] };

        await expect(verifyAuth(req, options)).rejects.toEqual({
          code: 403,
          message: 'Forbidden: Requires one of roles [superAdmin]',
        });
      });

      it('should throw 403 error when user lacks all required roles', async () => {
        const mockDecoded = {
          uid: 'regular-user-id',
          email: 'user@example.com',
          donor: true,
        };
        mockAuth.verifyIdToken.mockResolvedValue(mockDecoded);

        const req = createMockRequest({
          headers: { authorization: 'Bearer user-token' },
        });

        const options: AuthCheckOptions = { requiredRoles: ['superAdmin', 'orphanageAdmin'] };

        await expect(verifyAuth(req, options)).rejects.toEqual({
          code: 403,
          message: 'Forbidden: Requires one of roles [superAdmin, orphanageAdmin]',
        });
      });

      it('should pass when no roles are required', async () => {
        const mockDecoded = {
          uid: 'regular-user-id',
          email: 'user@example.com',
        };
        mockAuth.verifyIdToken.mockResolvedValue(mockDecoded);

        const req = createMockRequest({
          headers: { authorization: 'Bearer user-token' },
        });

        const result = await verifyAuth(req, {});
        expect(result).toEqual(mockDecoded);
      });

      it('should pass when requiredRoles is empty array', async () => {
        const mockDecoded = {
          uid: 'regular-user-id',
          email: 'user@example.com',
        };
        mockAuth.verifyIdToken.mockResolvedValue(mockDecoded);

        const req = createMockRequest({
          headers: { authorization: 'Bearer user-token' },
        });

        const options: AuthCheckOptions = { requiredRoles: [] };
        const result = await verifyAuth(req, options);
        expect(result).toEqual(mockDecoded);
      });
    });
  });
});
