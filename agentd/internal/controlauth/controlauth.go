// Package controlauth implements the replay-resistant agentd v2 handshake.
package controlauth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"strings"
)

const context = "flock-agentd-control-v2"

// CredentialID is a non-secret stable selector for overlapping rotations.
func CredentialID(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:16])
}

// Nonce returns a 256-bit base64url nonce.
func Nonce() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

// ValidNonce rejects malformed or incorrectly-sized handshake nonces.
func ValidNonce(value string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == 32
}

// MAC binds both nonces, identities, versions, and negotiated capabilities.
func MAC(secret, role, nodeID, clientNonce, serverNonce, daemonVersion string, capabilities []string) string {
	message := strings.Join([]string{
		context,
		role,
		nodeID,
		clientNonce,
		serverNonce,
		daemonVersion,
		strings.Join(capabilities, ","),
	}, "\x00")
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(message))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Verify compares encoded MACs without data-dependent timing.
func Verify(expected, presented string) bool {
	if len(expected) != len(presented) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(presented)) == 1
}
