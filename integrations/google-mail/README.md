# Google Apps Script sender for MRX

This optional sender uses the owner's Google account. Consumer Google accounts
currently have an Apps Script quota of 100 email recipients per day. Delivery
and quota limits are controlled by Google; acceptance is not proof of inbox delivery.

1. Create a standalone Apps Script project and copy `Code.gs` into the editor.
2. In Project Settings → Script Properties set `MRX_MAIL_SECRET` to a new random
   secret of at least 32 characters. Store it only in Google and the server's secrets.
3. Run `authorizeMail` and authorize the MailApp sending permission as the owner.
   This function sends no email and does not request inbox-reading access.
4. Deploy a Web app: Execute as **Me**, Who has access **Anyone**. It accepts only
   timestamped HMAC-authenticated verification requests and fixed email content.
5. Set `GOOGLE_MAIL_URL` to the deployed `https://script.google.com/macros/s/…/exec`
   URL and `GOOGLE_MAIL_SECRET` to the same secret in Render. Save and redeploy.
   The configured Google sender takes priority over Brevo without deleting Brevo settings.
6. Test delivery on a real consenting recipient, then complete registration using
   the received code. No APK update is required to switch the mail transport.

Do not put the secret in the repository, APK, remote config, URL, or screenshots.
The server sends signed JSON over HTTPS. The bridge accepts requests within two
minutes, serializes sending, deduplicates request IDs, limits each recipient to
one message per minute, and respects the current Google quota. It stores neither
codes nor cleartext recipient addresses in Script Properties. Google still
processes and may retain email content as part of providing the sending service.

An HTTP 200 response alone is not success: the server requires JSON `ok: true`
with the matching request ID. It does not automatically retry ambiguous sends.
To revert to Brevo, remove **both** Google environment variables and redeploy.
Ordinary accounts always require email verification, whichever sender is active.

Local checks: `node --test integrations/google-mail/bridge.test.mjs` and
`(cd server && go test ./...)`.

References: [web apps](https://developers.google.com/apps-script/guides/web),
[MailApp](https://developers.google.com/apps-script/reference/mail/mail-app),
[quotas](https://developers.google.com/apps-script/guides/services/quotas).
