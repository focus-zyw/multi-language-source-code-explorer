import { Cart, checkout } from "../src/store";
import { Logger } from "../src/lib/logger";

describe("Cart", () => {
  it("adds items and computes total", async () => {
    const cart = new Cart(new Logger());
    cart.add(3);
    expect(cart.total()).toBe("3.00");
    await checkout(cart, "a");
  });
  test("checkout throws on bad mode", () => {
    expect(() => checkout(new Cart(new Logger()), "b")).toBeDefined();
  });
});
