/**
 * Must match the "Last updated" date shown on the public /terms and
 * /privacy pages on the Astro frontend. Bump these when those pages change
 * so new ConsentRecord rows reflect what the user actually agreed to.
 */
export const LEGAL_DOCUMENT_VERSIONS = {
  TERMS: '2026-08-01',
  PRIVACY: '2026-08-01',
} as const;

export const EMAIL_VERIFICATION_EXPIRY_HOURS = 24;
export const PASSWORD_RESET_EXPIRY_HOURS = 1;
export const LOGIN_CHALLENGE_EXPIRY_MINUTES = 10;

// How long after a refresh-token rotation a second presentation of the
// now-revoked old token is treated as a benign same-browser race (two
// requests firing in parallel, both holding the pre-rotation token) rather
// than real theft — see AuthService.refresh(). Comfortably wider than any
// realistic gap between two requests issued moments apart on the same
// page load, while nowhere near long enough to matter for an actually
// stolen-and-replayed token.
export const CONCURRENT_REFRESH_GRACE_SECONDS = 15;
