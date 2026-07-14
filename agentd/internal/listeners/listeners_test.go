package listeners

import (
	"strings"
	"testing"
)

func TestParseProcNetKeepsOnlyLoopbackWildcardListeners(t *testing.T) {
	fixture := `  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 0:0 00:0 0 1000 0 111
   1: 00000000:1F90 00000000:0000 0A 0:0 00:0 0 1000 0 222
   2: 0100007F:0016 00000000:0000 0A 0:0 00:0 0 1000 0 333
   3: 0501A8C0:1770 00000000:0000 0A 0:0 00:0 0 1000 0 444
   4: 0100007F:2328 00000000:0000 01 0:0 00:0 0 1000 0 555
`
	got, err := parseProcNet(strings.NewReader(fixture), 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["111"].port != 3000 || got["222"].port != 8080 {
		t.Fatalf("unexpected listeners: %+v", got)
	}
}

func TestOwningSessionWalksParentsAndBreaksCycles(t *testing.T) {
	parents := map[int]int{40: 30, 30: 20, 50: 51, 51: 50}
	if got := owningSession(40, parents, map[int]string{20: "session-a"}); got != "session-a" {
		t.Fatalf("got %q", got)
	}
	if got := owningSession(50, parents, map[int]string{20: "session-a"}); got != "" {
		t.Fatalf("cycle returned %q", got)
	}
}
