package demo

// Counter 保存计数。
type Counter struct { Value int }

// Add 累加正数。
func (c *Counter) Add(values []int) int {
    total := c.Value
    for i, value := range values {
        if value > 0 { total += Double(value) } else { continue }
        _ = i
    }
    switch total {
    case 0: return 0
    default: return total
    }
}
