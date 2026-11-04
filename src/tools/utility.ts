import type { Tool } from "./types.js";

export const getCurrentTime: Tool = {
  name: "get_current_time",
  description: "Get the current date and time, optionally in a given IANA time zone.",
  parameters: {
    type: "object",
    properties: {
      timezone: { type: "string", description: 'IANA time zone, e.g. "Asia/Shanghai". Defaults to UTC.' },
    },
  },
  run(args) {
    const timeZone = typeof args.timezone === "string" && args.timezone ? args.timezone : "UTC";
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(new Date());
    return JSON.stringify({ timezone: timeZone, now: formatted, iso: new Date().toISOString() });
  },
};

export const calculate: Tool = {
  name: "calculate",
  description: "Evaluate an arithmetic expression with + - * / % ^ and parentheses. Use it for any non-trivial math.",
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: 'e.g. "(1.5 + 2) * 3 ^ 2"' } },
    required: ["expression"],
  },
  run(args) {
    return String(evaluate(String(args.expression ?? "")));
  },
};

/** Recursive-descent arithmetic evaluator (no eval). */
export function evaluate(expression: string): number {
  const src = expression.replace(/\s+/g, "");
  let pos = 0;

  const peek = () => src[pos];
  const expect = (ch: string) => {
    if (src[pos] !== ch) throw new Error(`expected "${ch}" at position ${pos}`);
    pos++;
  };

  function primary(): number {
    if (peek() === "(") {
      pos++;
      const v = sum();
      expect(")");
      return v;
    }
    if (peek() === "-") {
      pos++;
      return -power();
    }
    if (peek() === "+") {
      pos++;
      return power();
    }
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(pos));
    if (!m) throw new Error(`unexpected "${peek() ?? "end of input"}" at position ${pos}`);
    pos += m[0].length;
    return Number(m[0]);
  }

  function power(): number {
    const base = primary();
    if (peek() === "^") {
      pos++;
      return base ** power(); // right-associative
    }
    return base;
  }

  function product(): number {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = src[pos++];
      const rhs = power();
      v = op === "*" ? v * rhs : op === "/" ? v / rhs : v % rhs;
    }
    return v;
  }

  function sum(): number {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = src[pos++];
      const rhs = product();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }

  if (!src) throw new Error("empty expression");
  const result = sum();
  if (pos !== src.length) throw new Error(`unexpected "${src[pos]}" at position ${pos}`);
  return result;
}
