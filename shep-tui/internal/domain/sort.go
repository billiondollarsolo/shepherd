package domain

import "sort"

// SortSessionsByAttention stably sorts sessions by attention rank (lower first),
// then by Name ascending. Mirrors STATUS_POLICY AttentionRank (PRODUCT.md §5).
func SortSessionsByAttention(sessions []Session) {
	sort.SliceStable(sessions, func(i, j int) bool {
		ri := sessions[i].Status.Policy().AttentionRank
		rj := sessions[j].Status.Policy().AttentionRank
		if ri != rj {
			return ri < rj
		}
		return sessions[i].Name < sessions[j].Name
	})
}
