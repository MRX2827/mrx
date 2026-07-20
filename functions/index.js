const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

exports.sendPushNotification = onDocumentCreated(
  "chats/{chatId}/messages/{msgId}",
  async (event) => {
    const msg = event.data?.data();
    const chatId = event.params.chatId;

    if (!msg || !msg.uid) return null;

    try {
      const db = getFirestore();

      // Получаем данные чата
      const chatDoc = await db.doc(`chats/${chatId}`).get();
      if (!chatDoc.exists) return null;
      const chat = chatDoc.data();

      // Все участники кроме отправителя
      const members = (chat.members || []).filter(uid => uid !== msg.uid);
      if (!members.length) return null;

      // Получаем FCM токены
      const userDocs = await Promise.all(
        members.map(uid => db.doc(`users/${uid}`).get())
      );

      const now = Date.now();
      const ACTIVE_CHAT_TTL_MS = 45_000;
      const recipients = userDocs
        .filter(d => d.exists && d.data()?.fcmToken)
        .map(d => {
          const data = d.data() || {};
          return { uid: d.id, token: data.fcmToken, data };
        })
        .filter(r => {
          const activeAtMs = Number(r.data.activeAtMs || 0);
          const isViewingThisChat =
            r.data.appActive === true &&
            r.data.activeChatId === chatId &&
            activeAtMs > 0 &&
            now - activeAtMs < ACTIVE_CHAT_TTL_MS;
          return !isViewingThisChat;
        });

      if (!recipients.length) return null;

      // Текст уведомления
      let body = msg.text || "";
      if (msg.type === "voice")  body = "🎙 Голосовое сообщение";
      else if (msg.type === "circle") body = "⭕ Видео-кружок";
      else if (msg.type === "image")  body = "🖼 Фото";
      else if (msg.type === "video")  body = "🎥 Видео";
      else if (msg.type === "file")   body = `📎 ${msg.fileName || "Файл"}`;
      else if (msg.type === "audio")  body = "🎵 Аудио";
      else if (msg.type === "sticker") body = msg.text || "Стикер";

      const senderName = msg.author || "Пользователь";
      const title = chat.type === "direct"
        ? senderName
        : `${chat.name || "Группа"}: ${senderName}`;

      // Отправляем каждому отдельно — надёжнее чем multicast
      const results = await Promise.allSettled(
        recipients.map(r =>
          getMessaging().send({
            token: r.token,
            notification: {
              title: title.substring(0, 100),
              body: body.substring(0, 200),
            },
            data: {
              chatId: chatId,
              senderId: msg.uid,
              type: msg.type || "text",
            },
            android: {
              priority: "high",
              ttl: 86400,
              notification: {
                channelId: "messages",
                priority: "high",
                defaultSound: true,
                defaultVibrateTimings: true,
              },
            },
          })
        )
      );

      let sent = 0;
      const badTokens = [];

      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          sent++;
        } else {
          const code = r.reason?.code || "";
          if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token"
          ) {
            badTokens.push(recipients[i].token);
          }
        }
      });

      // Удаляем невалидные токены
      if (badTokens.length > 0) {
        await Promise.allSettled(
          badTokens.map(token =>
            db.collection("users")
              .where("fcmToken", "==", token)
              .get()
              .then(snap => snap.forEach(d => d.ref.update({ fcmToken: null })))
          )
        );
      }

      console.log(`✅ Sent ${sent}/${recipients.length} for chat ${chatId}`);
      return null;
    } catch (e) {
      console.error("Push error:", e);
      return null;
    }
  }
);
