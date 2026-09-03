/** Strips control characters (CR/LF in particular) before user input reaches an email subject line — defense-in-depth against header injection, since a subject isn't HTML-rendered so escapeHtml() doesn't apply there. */
export function sanitizeForSubject(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
}

/** Contact-form fields are the only untrusted input interpolated into an email body here — everything else is a server-generated token/code. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Every email shares this shell (logo header, white card, footer) — `body`
 * is just the card's contents, so each email case only ever writes the
 * part that's actually different about it. `complianceFooter` is only
 * passed by commercial/marketing sends (see BulkEmailProcessor) that need
 * a visible opt-out link and mailing address below the standard tagline —
 * CAN-SPAM requires both in the body itself, not just as email headers.
 * Every other (transactional) email leaves it unset.
 */
// The real site icon, already publicly hosted as a static asset — not an
// environment-sensitive URL (unlike an unsubscribe/CTA link, which must
// point at whichever frontend actually issued the email), so it's safe to
// point at production directly rather than threading FRONTEND_URL through
// every renderEmail() call site just for a logo image.
const LOGO_ICON_URL = 'https://www.conference.contact/icons/icon-64.png';

export function renderEmail(body: string, complianceFooter?: string): string {
  return `<div style="background-color:#eeeef0;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;">
      <table role="presentation" style="margin:0 auto 28px;" cellpadding="0" cellspacing="0">
        <tr>
          <td style="width:28px;height:28px;vertical-align:middle;">
            <img src="${LOGO_ICON_URL}" width="28" height="28" alt="conference.contact" style="display:block;border-radius:7px;" />
          </td>
          <td style="padding-left:9px;font-size:17px;font-weight:800;color:#12152b;">conference<span style="color:#a9c022;">.</span>contact</td>
        </tr>
      </table>
      <div style="background-color:#ffffff;border:1px solid #e2e2e7;border-radius:16px;padding:40px 32px;text-align:center;">
        ${body}
      </div>
      <p style="text-align:center;margin-top:24px;font-size:12px;color:#9395a6;">conference.contact — the verified conference contact directory</p>
      ${complianceFooter ?? ''}
    </div>
  </div>`;
}

export function heading(text: string): string {
  return `<h1 style="margin:0;font-size:21px;font-weight:800;color:#12152b;line-height:1.35;">${text}</h1>`;
}

export function paragraph(text: string): string {
  return `<p style="margin:16px 0 0;font-size:15px;color:#5b5f73;line-height:1.6;">${text}</p>`;
}

export function footnote(text: string): string {
  return `<p style="margin:22px 0 0;font-size:13px;color:#9395a6;">${text}</p>`;
}

export function ctaButton(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;margin-top:28px;background-color:#c6e02e;color:#0b1454;font-weight:700;font-size:15px;text-decoration:none;padding:14px 34px;border-radius:999px;">${label}</a>`;
}
