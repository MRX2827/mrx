import React, { useEffect, useRef, useState } from "react";
import { api } from "./fb/core.js";

const messages = {
  unauthorized: "Войди в аккаунт снова.",
  "invalid password": "Текущий пароль указан неверно.",
  "invalid new password": "Новый пароль должен содержать минимум 6 символов и занимать не более 72 байт.",
  "password unchanged": "Придумай пароль, отличный от текущего.",
  "password changed concurrently": "Пароль уже изменился. Введи текущий пароль и повтори попытку.",
  "email invalid": "Проверь, правильно ли указан адрес.",
  "email unchanged": "Этот адрес уже привязан.",
  "email taken": "Этот адрес привязан к другому аккаунту.",
  "email conflict": "Адрес уже занят или запрос на смену изменился. Проверь адрес и запроси новый код.",
  "invalid code": "Неверный код подтверждения.",
  "code expired": "Код истёк. Запроси новый.",
  "too many attempts": "Слишком много попыток. Запроси новый код.",
  "wait a minute": "Подожди минуту перед повторной отправкой.",
  "mail send failed": "Адрес сохранён. Письмо отправить не удалось. Попробуй ещё раз.",
  "mail unavailable": "Отправка писем сейчас недоступна.",
};

export function AccountSecurity({ theme }) {
  const { text, text2, surface2, border, accent } = theme;
  const [account, setAccount] = useState(null);
  const [readError, setReadError] = useState(false);
  const [mode, setMode] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api("/auth/account", { signal: controller.signal }).then(setAccount).catch(() => {
      if (!controller.signal.aborted) setReadError(true);
    });
    return () => controller.abort();
  }, []);

  const show = next => {
    setMode(next);
    setResult(null);
  };

  const submit = async event => {
    event.preventDefault();
    if (working.current) return;
    const data = new FormData(event.currentTarget);
    const currentPassword = data.get("currentPassword");
    const newPassword = data.get("newPassword");
    if (mode === "password" && newPassword !== data.get("repeatPassword")) {
      setResult({ error: true, text: "Новые пароли не совпадают." });
      return;
    }
    working.current = true;
    setBusy(true);
    setResult(null);
    try {
      if (mode === "password") {
        await api("/auth/account/password", { method: "POST", body: { currentPassword, newPassword } });
        setMode("");
        setResult({ text: "Пароль изменён." });
      } else if (mode === "email") {
        const next = await api("/auth/account/email", { method: "POST", body: { currentPassword, email: data.get("email") } });
        setAccount(next);
        setMode(next.codeSent ? "confirm" : "");
        setResult({ text: next.codeSent ? "Код отправлен на новый адрес." : "Новый адрес сохранён и ожидает подтверждения." });
      } else {
        const next = await api("/auth/account/email/confirm", { method: "POST", body: { email: account.pendingEmail, code: data.get("code") } });
        setAccount(next);
        setMode("");
        setResult({ text: "Новый адрес подтверждён и привязан к аккаунту." });
      }
    } catch (error) {
      if (mode === "email" && (error.status === 503 || error.status === 429)) {
        await api("/auth/account").then(setAccount).catch(() => {});
      }
      setResult({ error: true, text: messages[error.message] || "Не удалось сохранить изменения. Попробуй ещё раз." });
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const field = { width: "100%", padding: "11px 12px", background: surface2, color: text, border: `1px solid ${border}`, borderRadius: 10, font: "inherit" };
  const button = { padding: "10px 12px", color: text, background: surface2, border: `1px solid ${border}`, borderRadius: 10, font: "inherit", cursor: "pointer" };
  const passwordField = (name, label, autoComplete) => (
    <label style={{ display: "grid", gap: 5 }}>{label}
      <input name={name} type="password" autoComplete={autoComplete} minLength={name === "currentPassword" ? undefined : 6} required style={field}/>
    </label>
  );

  return (
    <section aria-label="Аккаунт" style={{ padding: "16px 15px", display: "grid", gap: 12, color: text, fontSize: 14 }}>
      <div style={{ color: text2, fontSize: 11, fontWeight: 800, letterSpacing: ".5px" }}>АККАУНТ</div>
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <strong>Почта аккаунта</strong>
        <span style={{ color: text2, overflowWrap: "anywhere" }}>{account ? account.email || "Не привязана" : readError ? "Не удалось загрузить адрес" : "Загрузка…"}</span>
        {account?.email && <span style={{ color: text2, fontSize: 12 }}>{account.emailVerified ? "Подтверждена" : "Не подтверждена"}</span>}
      </div>
      {account?.pendingEmail && <div style={{ color: text2, overflowWrap: "anywhere" }}>
        <strong style={{ color: text }}>Ожидает подтверждения</strong>
        <div>{account.pendingEmail}</div>
        {account.mailEnabled && <button type="button" style={{ ...button, marginTop: 8 }} disabled={busy} onClick={() => show("confirm")}>Ввести код</button>}
      </div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" style={button} disabled={busy} onClick={() => show("password")}>Сменить пароль</button>
        <button type="button" style={button} disabled={busy || !account} onClick={() => show("email")}>{account?.email ? "Сменить почту" : "Привязать почту"}</button>
      </div>
      {account && !account.mailEnabled && (mode === "email" || account.pendingEmail) && (
        <p style={{ color: text2, fontSize: 12, lineHeight: 1.45 }}>Отправка писем сейчас недоступна. Новый адрес можно сохранить, а использовать для входа и восстановления — после подтверждения.</p>
      )}
      {mode && <form className="mrx-detail-enter" key={mode} onSubmit={submit} style={{ display: "grid", gap: 10 }}>
        {mode === "confirm" ? (
          <label style={{ display: "grid", gap: 5 }}>Код из письма
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required style={field}/>
          </label>
        ) : passwordField("currentPassword", "Текущий пароль", "current-password")}
        {mode === "password" && passwordField("newPassword", "Новый пароль", "new-password")}
        {mode === "password" && passwordField("repeatPassword", "Повтори новый пароль", "new-password")}
        {mode === "email" && (
          <label style={{ display: "grid", gap: 5 }}>Новая почта
            <input name="email" type="email" autoComplete="email" defaultValue={account.pendingEmail} maxLength={120} required style={field}/>
          </label>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" disabled={busy} style={{ ...button, borderColor: accent, fontWeight: 700 }}>
            {busy ? "Подожди…" : mode === "password" ? "Сохранить пароль" : mode === "confirm" ? "Подтвердить адрес" : account.mailEnabled ? "Отправить код" : "Сохранить адрес"}
          </button>
          <button type="button" disabled={busy} style={button} onClick={() => show("")}>Отмена</button>
        </div>
      </form>}
      {result && <p className="mrx-detail-enter" role={result.error ? "alert" : "status"} style={{ color: result.error ? "#ff7979" : text2, lineHeight: 1.45 }}>{result.text}</p>}
    </section>
  );
}
