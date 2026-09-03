// Original prospect-cold-invite copy — the fallback whenever an admin
// hasn't edited the template (ProspectInviteCampaignSettings.email* columns
// are null). Shared between BulkEmailProcessor (actually sending) and
// ProspectCampaignService (reporting the current effective values to the
// admin dashboard) so the two can never drift out of sync.
export const DEFAULT_SUBJECT =
  "You've been invited to check out conference.contact";
export const DEFAULT_HEADING = 'Thought this might be useful';
export const DEFAULT_BODY =
  'A hand-verified directory of B2B conference contacts, with an AI tool that finds and enriches new leads live — take a look and see what’s inside.';
export const DEFAULT_CTA_LABEL = 'Take a look →';
export const DEFAULT_FOOTNOTE =
  'No obligation — you can create a free account just to browse.';
