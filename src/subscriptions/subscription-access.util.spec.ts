import {
  daysPastDue,
  hasActiveAccess,
  hasDirectoryAccess,
} from './subscription-access.util';

describe('hasActiveAccess', () => {
  it('grants access for ACTIVE and TRIALING regardless of pastDueSince', () => {
    expect(hasActiveAccess({ status: 'ACTIVE', pastDueSince: null }, 7)).toBe(
      true,
    );
    expect(hasActiveAccess({ status: 'TRIALING', pastDueSince: null }, 7)).toBe(
      true,
    );
  });

  it('grants access for PAST_DUE within the grace period', () => {
    const justWentPastDue = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    expect(
      hasActiveAccess({ status: 'PAST_DUE', pastDueSince: justWentPastDue }, 7),
    ).toBe(true);
  });

  it('denies access for PAST_DUE once the grace period has elapsed', () => {
    const wellPastGrace = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(
      hasActiveAccess({ status: 'PAST_DUE', pastDueSince: wellPastGrace }, 7),
    ).toBe(false);
  });

  it('grants access for PAST_DUE with no pastDueSince set (defensive: never punish a bookkeeping gap)', () => {
    expect(hasActiveAccess({ status: 'PAST_DUE', pastDueSince: null }, 7)).toBe(
      true,
    );
  });

  it('denies access for CANCELED and EXPIRED', () => {
    expect(hasActiveAccess({ status: 'CANCELED', pastDueSince: null }, 7)).toBe(
      false,
    );
    expect(hasActiveAccess({ status: 'EXPIRED', pastDueSince: null }, 7)).toBe(
      false,
    );
  });
});

describe('hasDirectoryAccess', () => {
  it('grants permanent access for CANCELED (paid once, left on their own terms)', () => {
    expect(
      hasDirectoryAccess({ status: 'CANCELED', pastDueSince: null }, 7),
    ).toBe(true);
  });

  it('still denies access for EXPIRED (never paid, or grace period lapsed into expiry)', () => {
    expect(
      hasDirectoryAccess({ status: 'EXPIRED', pastDueSince: null }, 7),
    ).toBe(false);
  });

  it('denies access for PAST_DUE once the grace period has elapsed, same as hasActiveAccess', () => {
    const wellPastGrace = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(
      hasDirectoryAccess(
        { status: 'PAST_DUE', pastDueSince: wellPastGrace },
        7,
      ),
    ).toBe(false);
  });
});

describe('daysPastDue', () => {
  it('returns null when never past due', () => {
    expect(daysPastDue(null)).toBeNull();
  });

  it('returns 0 on the first day, floored, not negative', () => {
    const justNow = new Date(Date.now() - 60 * 1000);
    expect(daysPastDue(justNow)).toBe(0);
  });

  it('returns whole elapsed days', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(daysPastDue(threeDaysAgo)).toBe(3);
  });
});
