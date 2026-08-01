package backend

import (
	"errors"
	"testing"
)

func TestErrNotSupported(t *testing.T) {
	if ErrNotSupported == nil {
		t.Fatal("ErrNotSupported is nil")
	}
	if !errors.Is(ErrNotSupported, ErrNotSupported) {
		t.Fatal("errors.Is self-match failed")
	}
	if ErrNotSupported.Error() == "" {
		t.Fatal("empty error message")
	}
}
