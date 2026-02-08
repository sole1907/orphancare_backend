// Tests for corsUtils.ts

// Mock logger before importing
jest.mock('firebase-functions/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

import { handleCors } from '../../functions/src/lib/corsUtils';
import { createMockRequest, createMockResponse, createPreflightRequest } from '../setup/testHelpers';

describe('corsUtils', () => {
  const allowedOrigins = [
    'https://orphancare-93b41.web.app',
    'http://localhost:3000',
  ];

  describe('handleCors', () => {
    it('should set CORS headers for allowed origin', () => {
      const req = createMockRequest({
        method: 'POST',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      const handled = handleCors(req, res, allowedOrigins);

      expect(handled).toBe(false);
      expect(res.getHeader('Access-Control-Allow-Origin')).toBe('https://orphancare-93b41.web.app');
      expect(res.getHeader('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
      expect(res.getHeader('Access-Control-Allow-Headers')).toBe(
        'Content-Type, Authorization, Origin, Accept, x-admin-key'
      );
    });

    it('should set CORS headers for localhost origin', () => {
      const req = createMockRequest({
        method: 'GET',
        headers: { origin: 'http://localhost:3000' },
      });
      const res = createMockResponse();

      const handled = handleCors(req, res, allowedOrigins);

      expect(handled).toBe(false);
      expect(res.getHeader('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    });

    it('should not set origin header for disallowed origin', () => {
      const req = createMockRequest({
        method: 'POST',
        headers: { origin: 'https://malicious-site.com' },
      });
      const res = createMockResponse();

      handleCors(req, res, allowedOrigins);

      expect(res.getHeader('Access-Control-Allow-Origin')).toBeUndefined();
      // Other headers should still be set
      expect(res.getHeader('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    });

    it('should handle OPTIONS preflight request and return true', () => {
      const req = createPreflightRequest('https://orphancare-93b41.web.app');
      const res = createMockResponse();

      const handled = handleCors(req, res, allowedOrigins);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(204);
      expect(res._getData()).toBe('');
    });

    it('should not block non-OPTIONS requests', () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

      methods.forEach((method) => {
        const req = createMockRequest({
          method,
          headers: { origin: 'https://orphancare-93b41.web.app' },
        });
        const res = createMockResponse();

        const handled = handleCors(req, res, allowedOrigins);

        expect(handled).toBe(false);
      });
    });

    it('should handle request without origin header', () => {
      const req = createMockRequest({
        method: 'POST',
        headers: {},
      });
      const res = createMockResponse();

      const handled = handleCors(req, res, allowedOrigins);

      expect(handled).toBe(false);
      expect(res.getHeader('Access-Control-Allow-Origin')).toBeUndefined();
      expect(res.getHeader('Access-Control-Allow-Methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
    });

    it('should work with empty allowed origins list', () => {
      const req = createMockRequest({
        method: 'POST',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      const handled = handleCors(req, res, []);

      expect(handled).toBe(false);
      expect(res.getHeader('Access-Control-Allow-Origin')).toBeUndefined();
    });

    it('should handle OPTIONS request from disallowed origin', () => {
      const req = createPreflightRequest('https://malicious-site.com');
      const res = createMockResponse();

      const handled = handleCors(req, res, allowedOrigins);

      expect(handled).toBe(true); // Still handles preflight
      expect(res.statusCode).toBe(204);
      expect(res.getHeader('Access-Control-Allow-Origin')).toBeUndefined();
    });

    it('should set correct allowed headers including x-admin-key', () => {
      const req = createMockRequest({
        method: 'GET',
        headers: { origin: 'http://localhost:3000' },
      });
      const res = createMockResponse();

      handleCors(req, res, allowedOrigins);

      const allowedHeaders = res.getHeader('Access-Control-Allow-Headers') as string;
      expect(allowedHeaders).toContain('x-admin-key');
      expect(allowedHeaders).toContain('Authorization');
      expect(allowedHeaders).toContain('Content-Type');
    });

    it('should set correct allowed methods', () => {
      const req = createMockRequest({
        method: 'POST',
        headers: { origin: 'https://orphancare-93b41.web.app' },
      });
      const res = createMockResponse();

      handleCors(req, res, allowedOrigins);

      const methods = res.getHeader('Access-Control-Allow-Methods') as string;
      expect(methods).toContain('GET');
      expect(methods).toContain('POST');
      expect(methods).toContain('PUT');
      expect(methods).toContain('DELETE');
      expect(methods).toContain('OPTIONS');
    });
  });
});
