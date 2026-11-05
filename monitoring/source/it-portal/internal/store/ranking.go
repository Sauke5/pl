package store

// Near recognizes one insertion, deletion, substitution or adjacent transposition.
// It only boosts already-selected database candidates and never invents aliases.
func Near(a, b string) bool {
	x, y := []rune(a), []rune(b)
	if len(x) < 4 || len(y) < 4 || len(x)-len(y) > 1 || len(y)-len(x) > 1 {
		return false
	}
	d := make([][]int, len(x)+1)
	for i := range d {
		d[i] = make([]int, len(y)+1)
		d[i][0] = i
	}
	for j := range d[0] {
		d[0][j] = j
	}
	for i := 1; i <= len(x); i++ {
		for j := 1; j <= len(y); j++ {
			cost := 0
			if x[i-1] != y[j-1] {
				cost = 1
			}
			d[i][j] = min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+cost)
			if i > 1 && j > 1 && x[i-1] == y[j-2] && x[i-2] == y[j-1] {
				d[i][j] = min(d[i][j], d[i-2][j-2]+1)
			}
		}
	}
	return d[len(x)][len(y)] <= 1
}
