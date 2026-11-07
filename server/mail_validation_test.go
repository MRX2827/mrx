package main

import (
	"errors"
	"net/textproto"
	"strings"
	"testing"
)

func TestEmailValidationDoesNotRestrictProviders(t *testing.T) {
	for _, email := range []string{
		"name+tag@protonmail.com", "first.last@tutanota.com", "a@b.co",
		"user@subdomain.private.example", "user@xn--e1afmkfd.xn--p1ai",
		strings.Repeat("a", 64) + "@" + strings.Repeat("b", 63) + ".example.org",
	} {
		if !validEmail(email) {
			t.Errorf("valid address rejected: %s", email)
		}
	}
	for _, email := range []string{"", "no-address", "a@@b.com", "a@localhost", "a b@example.org", "a@example.org\r\nBcc:other@example.org", strings.Repeat("a", 250) + "@b.com"} {
		if validEmail(email) {
			t.Error("malformed address accepted")
		}
	}
}

func TestSMTPFailureClassification(t *testing.T) {
	for _, message := range []string{
		"5.7.0 Your SMTP account is not yet activated. Please contact support.",
		"Your sending platform is currently disabled",
	} {
		if !errors.Is(brevoSMTPError("DATA", &textproto.Error{Code: 502, Msg: message}), errMailInactive) {
			t.Fatal("inactive provider must have a distinct failure reason")
		}
	}
	if !errors.Is(brevoSMTPError("recipient", &textproto.Error{Code: 550, Msg: "recipient unavailable"}), errMailDelivery) {
		t.Fatal("a recipient rejection must not be mistaken for provider inactivity")
	}
}
