package proto

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestControlFrameRoundTrip(t *testing.T) {
	in := Control{
		Op:              "hello",
		ProtocolVersion: ProtocolVersion,
		NodeID:          "node-contract-test",
		ClientNonce:     "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		CredentialID:    "credential-id",
	}
	var wire bytes.Buffer
	if err := WriteControl(&wire, in); err != nil {
		t.Fatal(err)
	}
	typ, payload, err := ReadFrame(&wire)
	if err != nil {
		t.Fatal(err)
	}
	if typ != TypeControl {
		t.Fatalf("frame type = %d", typ)
	}
	out, err := DecodeControl(payload)
	if err != nil {
		t.Fatal(err)
	}
	if out.Op != in.Op || out.ProtocolVersion != in.ProtocolVersion || out.NodeID != in.NodeID ||
		out.ClientNonce != in.ClientNonce || out.CredentialID != in.CredentialID {
		t.Fatalf("round trip mismatch: %#v", out)
	}
}

func TestSessionDataRoundTrip(t *testing.T) {
	payload := EncodeData("session-1", []byte("hello"))
	sid, data, err := DecodeData(payload)
	if err != nil {
		t.Fatal(err)
	}
	if sid != "session-1" || string(data) != "hello" {
		t.Fatalf("sid=%q data=%q", sid, data)
	}
}

func TestRejectsMalformedFrameAndDataLengths(t *testing.T) {
	var zero [4]byte
	if _, _, err := ReadFrame(bytes.NewReader(zero[:])); err == nil {
		t.Fatal("accepted zero-length frame")
	}
	var oversized [4]byte
	binary.BigEndian.PutUint32(oversized[:], maxFrame+1)
	if _, _, err := ReadFrame(bytes.NewReader(oversized[:])); err == nil {
		t.Fatal("accepted oversized frame")
	}
	if _, _, err := DecodeData([]byte{0, 4, 'a'}); err == nil {
		t.Fatal("accepted overflowing session id")
	}
}
