package controlauth

import "testing"

func TestSharedHandshakeVector(t *testing.T) {
	got := MAC(
		"0123456789abcdef0123456789abcdef",
		"server",
		"node-1234",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
		"0.3.0",
		[]string{"pty", "resize", "scrollback"},
	)
	const want = "pSdsQrZCMrYUFj85DnoQGcbUl2Jjr7kiehtn60Voruc"
	if got != want {
		t.Fatalf("shared vector mismatch: got %q want %q", got, want)
	}
}

func TestNonceShapeAndVerification(t *testing.T) {
	nonce, err := Nonce()
	if err != nil || !ValidNonce(nonce) {
		t.Fatalf("bad nonce %q: %v", nonce, err)
	}
	if ValidNonce("short") {
		t.Fatal("accepted short nonce")
	}
	if !Verify("same", "same") || Verify("same", "different") {
		t.Fatal("MAC comparison failed")
	}
}
