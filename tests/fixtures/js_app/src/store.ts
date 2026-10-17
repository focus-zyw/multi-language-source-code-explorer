import { format, type Fmt } from "./format";
import * as math from "./math.js";
import { Logger } from "@/lib/logger";

/** 购物车 */
export class Cart {
  private items: number[] = [];
  constructor(private logger: Logger) {}

  add(price: number): void {
    this.items.push(price);
    this.logger.info("added");
  }

  total(): string {
    let sum = 0;
    for (const p of this.items) {
      if (p < 0) continue;
      sum = math.add(sum, p);
    }
    return format(sum);
  }
}

export const makeCart = (logger: Logger) => new Cart(logger);

export async function checkout(cart: Cart, mode: "a" | "b") {
  switch (mode) {
    case "a":
      return cart.total();
    default:
      throw new Error("bad");
  }
}
