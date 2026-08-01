package vt

// Damage tracks a coarse dirty region on the visible grid.
// Zero value means "nothing dirty"; Full marks the whole screen.
type Damage struct {
	Dirty bool
	X0    int
	Y0    int
	X1    int // inclusive
	Y1    int // inclusive
	Full  bool
}

// Mark marks cell (x,y) dirty.
func (d *Damage) Mark(x, y int) {
	if !d.Dirty {
		d.Dirty = true
		d.X0, d.Y0, d.X1, d.Y1 = x, y, x, y
		return
	}
	if x < d.X0 {
		d.X0 = x
	}
	if y < d.Y0 {
		d.Y0 = y
	}
	if x > d.X1 {
		d.X1 = x
	}
	if y > d.Y1 {
		d.Y1 = y
	}
}

// MarkRect marks an inclusive rectangle dirty.
func (d *Damage) MarkRect(x0, y0, x1, y1 int) {
	d.Mark(x0, y0)
	d.Mark(x1, y1)
}

// MarkAll marks the entire screen dirty.
func (d *Damage) MarkAll() {
	d.Dirty = true
	d.Full = true
}

// Reset clears damage tracking after a successful paint.
func (d *Damage) Reset() {
	*d = Damage{}
}
