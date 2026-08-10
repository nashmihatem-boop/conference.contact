import { TokenService } from './token.service';

describe('TokenService', () => {
  const service = new TokenService();

  describe('generateOpaqueToken', () => {
    it('produces a high-entropy, URL-safe token', () => {
      const token = service.generateOpaqueToken();
      expect(token.length).toBeGreaterThanOrEqual(40); // base64url(32 bytes) ~= 43 chars
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('never repeats across calls', () => {
      const tokens = new Set(
        Array.from({ length: 100 }, () => service.generateOpaqueToken()),
      );
      expect(tokens.size).toBe(100);
    });
  });

  describe('generateNumericCode', () => {
    it('is always exactly 6 digits, zero-padded', () => {
      for (let i = 0; i < 50; i++) {
        const code = service.generateNumericCode();
        expect(code).toMatch(/^\d{6}$/);
      }
    });
  });

  describe('hash', () => {
    it('is deterministic for the same input', () => {
      expect(service.hash('same-value')).toBe(service.hash('same-value'));
    });

    it('differs for different inputs', () => {
      expect(service.hash('a')).not.toBe(service.hash('b'));
    });

    it('produces a 64-character hex sha256 digest', () => {
      expect(service.hash('anything')).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
