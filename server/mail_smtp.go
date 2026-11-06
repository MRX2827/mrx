package main

import (
	"crypto/tls"
	"fmt"
	"log"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/smtp"
	"net/textproto"
	"strings"
	"time"
)

const brevoSMTPHost = "smtp-relay.brevo.com"

func sendBrevoSMTPCode(email, code string) error {
	if !validEmail(cfgMailFrom) || !validEmail(email) {
		return errMailDelivery
	}
	connection, err := net.DialTimeout("tcp", net.JoinHostPort(brevoSMTPHost, "2525"), 8*time.Second)
	if err != nil {
		return brevoSMTPError("connect", err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return brevoSMTPError("set deadline", err)
	}
	client, err := smtp.NewClient(connection, brevoSMTPHost)
	if err != nil {
		return brevoSMTPError("greeting", err)
	}
	defer client.Close()

	if err := client.StartTLS(&tls.Config{ServerName: brevoSMTPHost, MinVersion: tls.VersionTLS12}); err != nil {
		return brevoSMTPError("STARTTLS", err)
	}
	auth := smtp.PlainAuth("", cfgBrevoSMTPLogin, cfgBrevoSMTPKey, brevoSMTPHost)
	if err := client.Auth(auth); err != nil {
		return brevoSMTPError("authentication", err)
	}
	if err := client.Mail(cfgMailFrom); err != nil {
		return brevoSMTPError("sender", err)
	}
	if err := client.Rcpt(email); err != nil {
		return brevoSMTPError("recipient", err)
	}
	message, err := client.Data()
	if err != nil {
		return brevoSMTPError("DATA", err)
	}

	var body strings.Builder
	fmt.Fprintf(&body, "From: MRX <%s>\r\nTo: <%s>\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n",
		cfgMailFrom, email, mime.QEncoding.Encode("UTF-8", "MRX: код подтверждения"), time.Now().Format(time.RFC1123Z))
	encoder := quotedprintable.NewWriter(&body)
	if _, err := fmt.Fprintf(encoder, "Код подтверждения MRX: %s\r\nКод действует 15 минут.\r\n", code); err != nil {
		return brevoSMTPError("encode", err)
	}
	if err := encoder.Close(); err != nil {
		return brevoSMTPError("encode", err)
	}
	if _, err := fmt.Fprint(message, body.String()); err != nil {
		return brevoSMTPError("write message", err)
	}
	if err := message.Close(); err != nil {
		return brevoSMTPError("accept message", err)
	}
	return nil
}

func brevoSMTPError(stage string, err error) error {
	if response, ok := err.(*textproto.Error); ok {
		log.Printf("MAIL: Brevo SMTP %s failed (SMTP %d)", stage, response.Code)
	} else {
		log.Printf("MAIL: Brevo SMTP %s failed", stage)
	}
	return errMailDelivery
}
