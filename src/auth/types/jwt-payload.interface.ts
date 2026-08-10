import { Role } from '../../../generated/prisma/enums';

/** Signed access token payload. `type: 'access'` prevents a login-challenge or any other short-lived signed token from being replayed as a real access token. */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
  type: 'access';
  /** Present only on an admin-minted "view as this user" token — the admin's own user id. Never set by a normal login. Purely informational for the client UI (impersonation banner); the guard behavior is identical either way. */
  impersonatedBy?: string;
}

export type LoginChallengeMethod = 'EMAIL_CODE' | 'TOTP';

/** Signed, stateless "you passed step 1, now prove the second factor" token — never accepted by JwtAuthGuard. */
export interface LoginChallengePayload {
  sub: string;
  deviceId: string;
  type: 'login_challenge';
  method: LoginChallengeMethod;
  /** Only present for EMAIL_CODE — sha256 of the code, checked at verify time. Absent for TOTP, which is verified against the user's stored secret instead. */
  codeHash?: string;
}
