package pen

import (
	"fmt"
	"testing"

	"github.com/billiondollarsolo/shep-tui/internal/domain"
)

func TestLayoutInvalidN(t *testing.T) {
	area := Rect{X: 0, Y: 0, W: 80, H: 24}
	for _, n := range []int{0, -1, 5, 100} {
		if got := Layout(domain.PenLayoutCols, n, area); got != nil {
			t.Fatalf("n=%d: want nil, got %#v", n, got)
		}
	}
}

func TestLayoutEmptyArea(t *testing.T) {
	for _, area := range []Rect{
		{},
		{W: 0, H: 10},
		{W: 10, H: 0},
		{W: -1, H: 10},
		{W: 10, H: -1},
	} {
		for _, layout := range allLayouts() {
			if got := Layout(layout, 2, area); got != nil {
				t.Fatalf("layout=%s area=%+v: want nil, got %#v", layout, area, got)
			}
		}
	}
}

func TestLayoutUnknown(t *testing.T) {
	area := Rect{W: 40, H: 20}
	if got := Layout(domain.PenLayout("nope"), 2, area); got != nil {
		t.Fatalf("unknown layout: want nil, got %#v", got)
	}
}

func TestColsEqualWidth(t *testing.T) {
	area := Rect{X: 2, Y: 3, W: 12, H: 10}
	got := Layout(domain.PenLayoutCols, 3, area)
	want := []Rect{
		{X: 2, Y: 3, W: 4, H: 10},
		{X: 6, Y: 3, W: 4, H: 10},
		{X: 10, Y: 3, W: 4, H: 10},
	}
	assertRects(t, got, want)
	assertTiles(t, got, area)
}

func TestRowsEqualHeight(t *testing.T) {
	area := Rect{X: 1, Y: 2, W: 20, H: 9}
	got := Layout(domain.PenLayoutRows, 3, area)
	want := []Rect{
		{X: 1, Y: 2, W: 20, H: 3},
		{X: 1, Y: 5, W: 20, H: 3},
		{X: 1, Y: 8, W: 20, H: 3},
	}
	assertRects(t, got, want)
	assertTiles(t, got, area)
}

func TestColsRemainderDistributed(t *testing.T) {
	// 10 width / 3 panes → 4,3,3 (first gets leftover)
	area := Rect{W: 10, H: 5}
	got := Layout(domain.PenLayoutCols, 3, area)
	want := []Rect{
		{X: 0, Y: 0, W: 4, H: 5},
		{X: 4, Y: 0, W: 3, H: 5},
		{X: 7, Y: 0, W: 3, H: 5},
	}
	assertRects(t, got, want)
	assertTiles(t, got, area)
}

func TestRowsRemainderDistributed(t *testing.T) {
	// 11 height / 3 → 4,4,3
	area := Rect{W: 8, H: 11}
	got := Layout(domain.PenLayoutRows, 3, area)
	want := []Rect{
		{X: 0, Y: 0, W: 8, H: 4},
		{X: 0, Y: 4, W: 8, H: 4},
		{X: 0, Y: 8, W: 8, H: 3},
	}
	assertRects(t, got, want)
	assertTiles(t, got, area)
}

func TestGrid2x2(t *testing.T) {
	area := Rect{X: 0, Y: 0, W: 20, H: 10}

	t.Run("n1_full", func(t *testing.T) {
		got := Layout(domain.PenLayoutGrid2x2, 1, area)
		assertRects(t, got, []Rect{area})
	})

	t.Run("n2_top_row", func(t *testing.T) {
		got := Layout(domain.PenLayoutGrid2x2, 2, area)
		want := []Rect{
			{X: 0, Y: 0, W: 10, H: 10},
			{X: 10, Y: 0, W: 10, H: 10},
		}
		assertRects(t, got, want)
		assertTiles(t, got, area)
	})

	t.Run("n3_top_pair_bottom_full", func(t *testing.T) {
		got := Layout(domain.PenLayoutGrid2x2, 3, area)
		// rows split 5/5; top cols 10/10
		want := []Rect{
			{X: 0, Y: 0, W: 10, H: 5},
			{X: 10, Y: 0, W: 10, H: 5},
			{X: 0, Y: 5, W: 20, H: 5},
		}
		assertRects(t, got, want)
		assertTiles(t, got, area)
	})

	t.Run("n4_true_grid", func(t *testing.T) {
		got := Layout(domain.PenLayoutGrid2x2, 4, area)
		want := []Rect{
			{X: 0, Y: 0, W: 10, H: 5},
			{X: 10, Y: 0, W: 10, H: 5},
			{X: 0, Y: 5, W: 10, H: 5},
			{X: 10, Y: 5, W: 10, H: 5},
		}
		assertRects(t, got, want)
		assertTiles(t, got, area)
	})
}

func TestGrid2x2OddDimensions(t *testing.T) {
	// W=21 H=11 → leftover pixels distributed without gap/overlap
	area := Rect{W: 21, H: 11}
	for n := 1; n <= 4; n++ {
		got := Layout(domain.PenLayoutGrid2x2, n, area)
		if len(got) != n {
			t.Fatalf("n=%d: len=%d", n, len(got))
		}
		assertTiles(t, got, area)
	}
}

func TestMainStackWide(t *testing.T) {
	// Wider than tall → main left, stack right
	area := Rect{W: 30, H: 12}

	t.Run("n1", func(t *testing.T) {
		got := Layout(domain.PenLayoutMainStack, 1, area)
		assertRects(t, got, []Rect{area})
	})

	t.Run("n2", func(t *testing.T) {
		got := Layout(domain.PenLayoutMainStack, 2, area)
		// main 2/3 of 30 = 20; stack 10
		want := []Rect{
			{X: 0, Y: 0, W: 20, H: 12},
			{X: 20, Y: 0, W: 10, H: 12},
		}
		assertRects(t, got, want)
		assertTiles(t, got, area)
	})

	t.Run("n3", func(t *testing.T) {
		got := Layout(domain.PenLayoutMainStack, 3, area)
		// main W=20; stack H split 6/6
		want := []Rect{
			{X: 0, Y: 0, W: 20, H: 12},
			{X: 20, Y: 0, W: 10, H: 6},
			{X: 20, Y: 6, W: 10, H: 6},
		}
		assertRects(t, got, want)
		assertTiles(t, got, area)
		if got[0].W <= got[1].W {
			t.Fatalf("main should be wider than stack pane: main=%d stack=%d", got[0].W, got[1].W)
		}
	})

	t.Run("n4", func(t *testing.T) {
		got := Layout(domain.PenLayoutMainStack, 4, area)
		// stack H: 12/3 = 4 each
		want := []Rect{
			{X: 0, Y: 0, W: 20, H: 12},
			{X: 20, Y: 0, W: 10, H: 4},
			{X: 20, Y: 4, W: 10, H: 4},
			{X: 20, Y: 8, W: 10, H: 4},
		}
		assertRects(t, got, want)
		assertTiles(t, got, area)
	})
}

func TestMainStackTall(t *testing.T) {
	// Taller than wide → main top, stack bottom (horizontal stack of remainder)
	area := Rect{W: 12, H: 30}

	got := Layout(domain.PenLayoutMainStack, 3, area)
	// main H = 2/3 * 30 = 20; stack H = 10 split into 2 cols of W=6
	want := []Rect{
		{X: 0, Y: 0, W: 12, H: 20},
		{X: 0, Y: 20, W: 6, H: 10},
		{X: 6, Y: 20, W: 6, H: 10},
	}
	assertRects(t, got, want)
	assertTiles(t, got, area)
}

func TestMainStackSquareUsesLeft(t *testing.T) {
	// W == H → main left (W >= H)
	area := Rect{W: 15, H: 15}
	got := Layout(domain.PenLayoutMainStack, 2, area)
	if got[0].X != area.X || got[0].Y != area.Y {
		t.Fatalf("main origin: %+v", got[0])
	}
	if got[0].H != area.H {
		t.Fatalf("square should use left main (full height), H=%d", got[0].H)
	}
	if got[0].W != 10 { // 15 * 2/3 = 10
		t.Fatalf("main W=%d want 10", got[0].W)
	}
	assertTiles(t, got, area)
}

func TestSinglePaneAllLayouts(t *testing.T) {
	area := Rect{X: 5, Y: 7, W: 40, H: 20}
	for _, layout := range allLayouts() {
		got := Layout(layout, 1, area)
		assertRects(t, got, []Rect{area})
	}
}

func TestResizeProperties(t *testing.T) {
	// Success criteria: resize properties — tiling + length stable across sizes.
	sizes := []Rect{
		{W: 1, H: 1},
		{W: 2, H: 1},
		{W: 1, H: 2},
		{W: 3, H: 3},
		{W: 80, H: 24},
		{W: 81, H: 25},
		{W: 100, H: 50},
		{W: 7, H: 99},
		{W: 99, H: 7},
		{X: 3, Y: 4, W: 17, H: 13},
	}
	for _, layout := range allLayouts() {
		for n := 1; n <= domain.MaxPenSessions; n++ {
			for _, area := range sizes {
				got := Layout(layout, n, area)
				if len(got) != n {
					t.Fatalf("%s n=%d area=%+v: len=%d", layout, n, area, len(got))
				}
				assertTiles(t, got, area)
				// No negative dimensions.
				for i, r := range got {
					if r.W < 0 || r.H < 0 {
						t.Fatalf("%s n=%d pane %d negative: %+v", layout, n, i, r)
					}
				}
			}
		}
	}
}

func TestDistribute(t *testing.T) {
	cases := []struct {
		length int
		n      int
		want   []int
	}{
		{10, 3, []int{4, 3, 3}},
		{9, 3, []int{3, 3, 3}},
		{1, 3, []int{1, 0, 0}},
		{0, 2, []int{0, 0}},
		{5, 1, []int{5}},
		{5, 5, []int{1, 1, 1, 1, 1}},
		{5, 6, []int{1, 1, 1, 1, 1, 0}},
	}
	for _, tc := range cases {
		got := distribute(tc.length, tc.n)
		if len(got) != len(tc.want) {
			t.Fatalf("len %d/%d: got %v want %v", tc.length, tc.n, got, tc.want)
		}
		sum := 0
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("%d/%d: got %v want %v", tc.length, tc.n, got, tc.want)
			}
			sum += got[i]
		}
		if tc.length > 0 && sum != tc.length {
			t.Fatalf("sum=%d want %d", sum, tc.length)
		}
	}
}

func TestRectHelpers(t *testing.T) {
	if !(Rect{}).Empty() {
		t.Fatal("zero rect should be empty")
	}
	if (Rect{W: 1, H: 1}).Empty() {
		t.Fatal("1x1 should not be empty")
	}
	if (Rect{W: 3, H: 4}).Area() != 12 {
		t.Fatal("area")
	}
	r := Rect{X: 2, Y: 3, W: 5, H: 4}
	if !r.Contains(2, 3) || !r.Contains(6, 6) {
		t.Fatal("should contain corners inclusive start")
	}
	if r.Contains(7, 3) || r.Contains(2, 7) || r.Contains(1, 3) {
		t.Fatal("should exclude outside / exclusive end")
	}
	if (Rect{}).Contains(0, 0) {
		t.Fatal("empty contains nothing")
	}
}

func TestMainSize(t *testing.T) {
	if mainSize(30) != 20 {
		t.Fatalf("mainSize(30)=%d want 20", mainSize(30))
	}
	if mainSize(1) != 1 {
		t.Fatalf("mainSize(1)=%d", mainSize(1))
	}
	if mainSize(2) != 1 {
		t.Fatalf("mainSize(2)=%d want 1 (leave room for stack)", mainSize(2))
	}
}

// --- helpers ---

func allLayouts() []domain.PenLayout {
	return []domain.PenLayout{
		domain.PenLayoutCols,
		domain.PenLayoutRows,
		domain.PenLayoutGrid2x2,
		domain.PenLayoutMainStack,
	}
}

func assertRects(t *testing.T, got, want []Rect) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("len got %d want %d\ngot  %#v\nwant %#v", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("pane %d: got %+v want %+v\nfull got  %#v\nfull want %#v", i, got[i], want[i], got, want)
		}
	}
}

// assertTiles checks that rects cover area exactly: no gaps, no overlaps,
// and union bounds match area.
func assertTiles(t *testing.T, rects []Rect, area Rect) {
	t.Helper()
	if area.Empty() {
		if len(rects) != 0 {
			t.Fatalf("empty area should produce no rects")
		}
		return
	}
	// Coverage grid — fine for unit-test sizes (max ~100×50 here).
	type key struct{ x, y int }
	seen := make(map[key]int)
	sumArea := 0
	for i, r := range rects {
		if r.W < 0 || r.H < 0 {
			t.Fatalf("pane %d negative: %+v", i, r)
		}
		// Zero-size panes are allowed when area < n (thin terminals); they
		// contribute no cells but must still sit on the partition.
		if r.W == 0 || r.H == 0 {
			continue
		}
		// Must be inside area.
		if r.X < area.X || r.Y < area.Y || r.X+r.W > area.X+area.W || r.Y+r.H > area.Y+area.H {
			t.Fatalf("pane %d %+v outside area %+v", i, r, area)
		}
		sumArea += r.W * r.H
		for y := r.Y; y < r.Y+r.H; y++ {
			for x := r.X; x < r.X+r.W; x++ {
				k := key{x, y}
				if seen[k] != 0 {
					t.Fatalf("overlap at (%d,%d) panes %d and %d", x, y, seen[k]-1, i)
				}
				seen[k] = i + 1
			}
		}
	}
	wantCells := area.W * area.H
	if len(seen) != wantCells {
		// Find a gap for a better error.
		for y := area.Y; y < area.Y+area.H; y++ {
			for x := area.X; x < area.X+area.W; x++ {
				if seen[key{x, y}] == 0 {
					t.Fatalf("gap at (%d,%d); covered %d/%d cells; rects=%s",
						x, y, len(seen), wantCells, fmtRects(rects))
				}
			}
		}
		t.Fatalf("covered %d want %d cells; rects=%s", len(seen), wantCells, fmtRects(rects))
	}
	if sumArea != wantCells {
		t.Fatalf("sum area %d want %d", sumArea, wantCells)
	}
}

func fmtRects(rects []Rect) string {
	s := "["
	for i, r := range rects {
		if i > 0 {
			s += " "
		}
		s += fmt.Sprintf("%+v", r)
	}
	return s + "]"
}
