using System;
using static Demo.MathUtil;

namespace Demo;

/// <summary>累计示例。</summary>
public class Counter : Base
{
    private int value;

    public Counter(int value) { this.value = value; }

    /// <summary>增加计数。</summary>
    public int Add(int amount)
    {
        int total = Twice(amount);
        int[] items = new int[] { amount };
        for (int i = 0; i < amount; i++) { total = Inc(total); }
        foreach (var item in items) { total += item; }
        try
        {
            if (total < 0) { throw new ArgumentException("negative"); }
            else { total += 0; }
        }
        catch (ArgumentException ex) { total = 0; }
        finally { this.value = total; }
        switch (amount)
        {
            case 0: return this.value;
            default: break;
        }
        while (total > 100) { break; }
        return total;
    }

    public int Convert(int value) { return value; }
    public string Convert(string value) { return value; }
    public string Run() { return Convert("text"); }
    public static void Main(string[] args) { new Counter(0).Add(1); }
    public int Local()
    {
        int Nested(int x) { return x; }
        return Nested(1);
    }
}
