// MRX verification mail bridge. Secrets belong in Script Properties, never here.
// Deploy as a web app executing as the owner; allow server requests without login.
// Each POST must carry a short-lived HMAC signature produced by the MRX server.

function authorizeMail() {
  // Run once to request only the MailApp sending scope. Sends no message.
  return MailApp.getRemainingDailyQuota();
}

function doGet() {
  return mailResult_({service: 'MRX verification mail', version: 1});
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length > 4096) return mailResult_({ok: false});
    const envelope = JSON.parse(raw);
    const properties = PropertiesService.getScriptProperties();
    const secret = properties.getProperty('MRX_MAIL_SECRET');
    if (!secret || secret.length < 32 || typeof envelope.payload !== 'string' ||
        !/^[a-f0-9]{64}$/.test(envelope.signature || '')) return mailResult_({ok: false});
    const expected = hex_(Utilities.computeHmacSha256Signature('mrx-mail-v1\n' + envelope.payload, secret, Utilities.Charset.UTF_8));
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ envelope.signature.charCodeAt(i);
    if (mismatch !== 0) return mailResult_({ok: false});
    const request = JSON.parse(envelope.payload);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(request.timestamp) || Math.abs(now - request.timestamp) > 120 ||
        !/^[a-f0-9]{32}$/.test(request.id || '') || !/^\d{6}$/.test(request.code || '') ||
        typeof request.recipient !== 'string' || request.recipient.length > 254 ||
        !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(request.recipient)) return mailResult_({ok: false});
    return sendVerifiedRequest_(properties, request, now);
  } catch (_) {
    // Never return or log recipient addresses, codes, signatures, or exceptions.
    return mailResult_({ok: false});
  }
}

function sendVerifiedRequest_(properties, request, now) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return mailResult_({ok: false, error: 'busy'});
  try {
    const idKey = 'MRX_MAIL_ID_' + request.id;
    const previous = properties.getProperty(idKey);
    if (previous) {
      const record = JSON.parse(previous);
      return mailResult_({ok: record.state === 'sent', id: request.id});
    }
    const recipientHash = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, request.recipient.toLowerCase(), Utilities.Charset.UTF_8));
    const toKey = 'MRX_MAIL_TO_' + recipientHash;
    const lastSent = Number(properties.getProperty(toKey) || 0);
    if (now - lastSent < 60) return mailResult_({ok: false, error: 'cooldown'});
    if (MailApp.getRemainingDailyQuota() < 1) return mailResult_({ok: false, error: 'quota'});
    // Bound persistent replay/cooldown records without storing addresses/codes.
    const saved = properties.getProperties();
    Object.keys(saved).forEach(function (key) {
      if (key.indexOf('MRX_MAIL_ID_') === 0) {
        try { if (now - JSON.parse(saved[key]).timestamp > 86400) properties.deleteProperty(key); } catch (_) { properties.deleteProperty(key); }
      } else if (key.indexOf('MRX_MAIL_TO_') === 0 && now - Number(saved[key]) > 86400) {
        properties.deleteProperty(key);
      }
    });
    // If Google fails ambiguously after accepting a message, a repeated signed
    // request must not send twice. Only an acknowledged 'sent' record is success.
    properties.setProperty(idKey, JSON.stringify({timestamp: now, state: 'pending'}));
    properties.setProperty(toKey, String(now));
    MailApp.sendEmail({
      to: request.recipient,
      subject: 'MRX: код подтверждения',
      name: 'MRX',
      body: 'Код подтверждения MRX: ' + request.code + '\n\nКод действует 15 минут. Никому не сообщайте этот код.\nЕсли вы не запрашивали код, проигнорируйте это письмо.'
    });
    properties.setProperty(idKey, JSON.stringify({timestamp: now, state: 'sent'}));
    return mailResult_({ok: true, id: request.id});
  } catch (_) {
    return mailResult_({ok: false});
  } finally {
    lock.releaseLock();
  }
}

function hex_(bytes) {
  return bytes.map(function (value) { return ('0' + ((value + 256) % 256).toString(16)).slice(-2); }).join('');
}

function mailResult_(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
