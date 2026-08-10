import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { EncryptionService } from './encryption.service';

function buildService(
  key = randomBytes(32).toString('base64'),
): EncryptionService {
  const config = { getOrThrow: () => key } as unknown as ConfigService;
  return new EncryptionService(config);
}

describe('EncryptionService', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const service = buildService();
    const plaintext = 'JBSWY3DPEHPK3PXP'; // shape of a real TOTP secret
    const encrypted = service.encrypt(plaintext);
    expect(service.decrypt(encrypted)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext each time (random IV)', () => {
    const service = buildService();
    const a = service.encrypt('same-secret');
    const b = service.encrypt('same-secret');
    expect(a).not.toBe(b);
  });

  it('rejects a key that is not 32 bytes when decoded', () => {
    expect(() =>
      buildService(Buffer.from('too-short').toString('base64')),
    ).toThrow(/32 bytes/);
  });

  it('throws rather than silently returning garbage when ciphertext is tampered with', () => {
    const service = buildService();
    const encrypted = service.encrypt('sensitive-value');
    const [iv, authTag, ciphertext] = encrypted.split(':');
    const tamperedCiphertext = Buffer.from(ciphertext, 'base64');
    tamperedCiphertext[0] ^= 0xff; // flip a bit
    const tampered = [iv, authTag, tamperedCiphertext.toString('base64')].join(
      ':',
    );

    expect(() => service.decrypt(tampered)).toThrow();
  });
});
