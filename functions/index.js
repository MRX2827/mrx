const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

function messageBody(msg) {
  if (msg.type === "voice") return "🎙 Голосовое сообщение";
  if (msg.type === "circle") return "⏺ Видео-кружок";
  if (msg.type === "image") return "🖼 Фото";
  if (msg.type === "video") return "🎥 Видео";
  if (msg.type === "file") return "📎 " + (msg.fileName || "Файл");
  if (msg.type === "audio") return "🎵 Аудио";
  if (msg.type === "sticker") return msg.text || "Стикер";
  return msg.text || "Новое сообщение";
}

function collectRecipientDevices(userDoc) {
  const user = userDoc.data() || {};
  const devices = [];
  const seenTokens = new Set();

  const add = (token, deviceId, preferences = {}, legacy = false) => {
    if (typeof token !== "string" || !token.trim() || seenTokens.has(token)) return;
    seenTokens.add(token);
    devices.push({
      uid: userDoc.id,
      token,
      deviceId,
      preferences: preferences && typeof preferences === "object" ? preferences : {},
      legacy,
    });
  };

  if (user.pushDevices && typeof user.pushDevices === "object") {
    Object.entries(user.pushDevices).forEach(([deviceId, device]) => {
      if (!device || typeof device !== "object") return;
      add(device.token, deviceId, device.preferences);
    });
  }

  // Совместимость с серверным push_firestore.go, который может ещё читать
  // единственное поле fcmToken. После обновления клиента токен уже дублируется
  // в карте устройств, поэтому один и тот же адрес не получит дубль.
  if (user.pushTransport === "fcm") {
    add(user.fcmToken, null, {}, true);
  }

  return devices;
}

function shouldNotify(device, chatId, chatType) {
  const preferences = device.preferences || {};
  if (Array.isArray(preferences.mutedChatIds) && preferences.mutedChatIds.includes(chatId)) {
    return false;
  }
  if (chatType !== "direct" && preferences.groups === false) return false;
  return true;
}

async function removeStaleDevice(db, recipient) {
  const patch = {};
  if (recipient.deviceId && /^[A-Za-z0-9_-]+$/.test(recipient.deviceId)) {
    patch["pushDevices." + recipient.deviceId] = FieldValue.delete();
  }
  if (recipient.legacy) patch.fcmToken = FieldValue.delete();
  if (!Object.keys(patch).length) return;
  await db.doc("users/" + recipient.uid).update(patch);
}

exports.sendPushNotification = onDocumentCreated(
  "chats/{chatId}/messages/{msgId}",
  async (event) => {
    const msg = event.data?.data();
    const chatId = event.params.chatId;
    if (!msg || !msg.uid || !chatId) return null;

    try {
      const db = getFirestore();
      const chatDoc = await db.doc("chats/" + chatId).get();
      if (!chatDoc.exists) return null;

      const chat = chatDoc.data() || {};
      const memberIds = (chat.members || []).filter(uid => uid && uid !== msg.uid);
      if (!memberIds.length) return null;

      const memberDocs = await Promise.all(
        memberIds.map(uid => db.doc("users/" + uid).get())
      );
      const recipients = memberDocs
        .filter(userDoc => userDoc.exists)
        .flatMap(collectRecipientDevices)
        .filter(device => shouldNotify(device, chatId, chat.type || "direct"));

      if (!recipients.length) return null;

      const senderName = msg.author || "Пользователь";
      const chatName = chat.name || "Группа";
      const fullTitle = chat.type === "direct" ? senderName : chatName + ": " + senderName;
      const fullBody = messageBody(msg);

      const results = await Promise.allSettled(
        recipients.map(recipient => {
          const previewAllowed = recipient.preferences.preview !== false;
          const title = previewAllowed ? fullTitle : "RedMrxGram";
          const body = previewAllowed ? fullBody : "Новое сообщение";

          return getMessaging().send({
            token: recipient.token,
            notification: {
              title: title.substring(0, 100),
              body: body.substring(0, 200),
            },
            data: {
              chatId: String(chatId),
              senderId: String(msg.uid),
              type: String(msg.type || "text"),
            },
            android: {
              priority: "high",
              ttl: 24 * 60 * 60 * 1000,
              collapseKey: "chat-" + chatId,
              notification: {
                channelId: "messages",
                tag: "chat-" + chatId,
                notificationPriority: "PRIORITY_HIGH",
                defaultSound: recipient.preferences.sound !== false,
                defaultVibrateTimings: recipient.preferences.vibration !== false,
              },
            },
          });
        })
      );

      let sent = 0;
      const staleRecipients = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          sent += 1;
          return;
        }
        const code = result.reason?.code || "";
        if (INVALID_TOKEN_CODES.has(code)) {
          staleRecipients.push(recipients[index]);
        } else {
          console.warn("⚠️ Push не отправлен: " + (code || "unknown-error"));
        }
      });

      await Promise.allSettled(
        staleRecipients.map(recipient => removeStaleDevice(db, recipient))
      );

      console.log("✅ Push: " + sent + "/" + recipients.length + " для чата " + chatId);
      return null;
    } catch (error) {
      console.error("❌ Ошибка отправки push:", error?.message || error);
      return null;
    }
  }
);
