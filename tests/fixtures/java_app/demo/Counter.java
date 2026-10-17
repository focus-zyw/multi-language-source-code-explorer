package demo;
import static demo.MathUtil.twice;

/** 累计示例。 */
public class Counter extends Base {
    private int value;
    public Counter(int value) { this.value = value; }

    /** 增加计数。 */
    public int add(int amount) {
        int total = twice(amount);
        for (int i = 0; i < amount; i++) { total = inc(total); }
        try {
            if (total < 0) { throw new IllegalArgumentException("negative"); }
        } catch (IllegalArgumentException ex) { total = 0; }
        finally { this.value = total; }
        switch (amount) {
            case 0: return this.value;
            default: return total;
        }
    }

    public int convert(int value) { return value; }
    public String convert(String value) { return value; }
    public String run() { return convert("text"); }
    public static void main(String[] args) { new Counter(0).add(1); }
}
