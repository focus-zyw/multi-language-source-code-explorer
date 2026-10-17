package demo;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
public class CounterTest {
    @Test public void adds() {
        Counter counter = new Counter(1);
        assertEquals(3, counter.add(1));
    }
}
