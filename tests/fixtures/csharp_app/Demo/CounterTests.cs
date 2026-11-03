using Xunit;

namespace Demo;

public class CounterTests
{
    [Fact]
    public void Adds()
    {
        Counter counter = new Counter(0);
        counter.Add(1);
    }
}
