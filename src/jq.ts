// A jq-subset expression engine: enough of the jq 1.7 language to pull values
// out of one tool's output and shape them into another tool's arguments.
// A program is parsed to an AST, checked, and compiled to closures that
// evaluate lazily with generators. Nothing here reaches outside (no
// environment, files, network or eval) and every loop is charged to a budget.
//
// Known differences from jq: regular expressions are JavaScript's (see
// "Regular expressions" below), numbers are doubles, `$ENV` and `env` are
// empty, and objects list integer-like keys first.
//
// The builtins written in jq (PRELUDE) and the behaviour of the native ones
// follow jq's src/builtin.jq and src/builtin.c (MIT license,
// Copyright (C) 2012 Stephen Dolan).

export class JqError extends Error {
  /** 0-based offset into the program, for syntax errors. */
  position?: number;
  /** The value given to error(v), when the program raised it. */
  value?: unknown;

  constructor(message: string, position?: number) {
    super(message);
    this.name = "JqError";
    if (position !== undefined) this.position = position;
  }
}

export interface JqOptions {
  /** $name variables. */
  vars?: Record<string, unknown>;
  /** Evaluation steps before giving up (default 10_000_000). */
  maxOps?: number;
  /** Outputs before giving up (default 100_000). */
  maxOutputs?: number;
  /** Longest string a program may build, in UTF-16 units (default 20_000_000). */
  maxString?: number;
}

export interface Program {
  readonly source: string;
  /** The $names the program reads without binding them itself, sorted, each once. */
  readonly freeVars: string[];
  /** For each use of a free variable, the literal field path read from it: $steps.pack.text gives ["steps","pack","text"]; $steps["a"].b gives ["steps","a","b"]; $steps[$x].y, $steps[0], $steps[] and a bare $steps give ["steps"]. Deduplicated. */
  readonly refs: string[][];
  /** Every output for input, in order. Throws JqError. Never mutates input or vars. */
  run(input: unknown, options?: JqOptions): unknown[];
}

const DEFAULT_MAX_OPS = 10_000_000;
const DEFAULT_MAX_OUTPUTS = 100_000;
const DEFAULT_MAX_STRING = 20_000_000;
/** The file name in `$__loc__`. */
const FILE = "<encela>";
/** How deep a program's syntax may nest. */
const MAX_NESTING = 250;

// ---------------------------------------------------------------------------
// Errors and budgets

/** "No output", for the evaluation that gives at most one value. */
const NONE = Symbol("none");

/** An error a program can catch with `try`. */
class Thrown {
  constructor(readonly value: unknown) {}
}

/** `break $label` on its way to its label. */
class BreakSignal {
  constructor(readonly label: object) {}
}

// One run at a time: `run` saves and restores these around itself.
let ops = 0;
let opsLimit = Number.POSITIVE_INFINITY;
let strLimit = Number.POSITIVE_INFINITY;

/** Charges `n` steps to the run. Budget errors are not catchable by `try`. */
function tick(n: number): void {
  ops += n;
  if (ops > opsLimit) {
    throw new JqError(`jq: the program took more than ${opsLimit} evaluation steps (maxOps)`);
  }
}

/** Checks the length of a string about to be built. */
function checkLength(n: number): void {
  if (n > strLimit) {
    throw new JqError(`jq: a string grew past ${strLimit} characters (maxString)`);
  }
}

function fail(message: string): never {
  throw new Thrown(message);
}

// ---------------------------------------------------------------------------
// Values

type Obj = Record<string, unknown>;
type Kind = "null" | "boolean" | "number" | "string" | "array" | "object";
/** A path element is a key, an index or a `{start, end}` slice. */
type Path = unknown[];

function kind(v: unknown): Kind {
  switch (typeof v) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return v === null ? "null" : Array.isArray(v) ? "array" : "object";
    case "undefined":
      return "null";
    default:
      throw new JqError(`jq: a ${typeof v} is not a JSON value`);
  }
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isContainer = (v: unknown): v is object => typeof v === "object" && v !== null;
const truthy = (v: unknown): boolean => v !== false && v != null;

/** Sets an own property. `__proto__` must not reach the prototype setter. */
function put(o: Obj, k: string, v: unknown): void {
  if (k === "__proto__") {
    Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  } else {
    o[k] = v;
  }
}

/** Reads an own property: nothing inherited is ever a field. */
function field(o: Obj, k: string): unknown {
  if (!Object.hasOwn(o, k)) return null;
  const v = o[k];
  return v === undefined ? null : v;
}

const HIGH_CHARS = /[\uD800-￿]/;

/** Compares strings by code point, as jq does (UTF-16 order differs above U+D7FF). */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i === n) return a.length < b.length ? -1 : 1;
  let x = a.charCodeAt(i);
  let y = b.charCodeAt(i);
  if (x >= 0xd800 && y >= 0xd800) {
    // Surrogates (code points from U+10000) sort after the rest of the BMP.
    x += x <= 0xdfff ? 0x2000 : -0x800;
    y += y <= 0xdfff ? 0x2000 : -0x800;
  }
  return x < y ? -1 : 1;
}

function sortedKeys(o: Obj): string[] {
  const keys = Object.keys(o).sort();
  for (const k of keys) {
    if (HIGH_CHARS.test(k)) return keys.sort(compareStrings);
  }
  return keys;
}

function rank(v: unknown): number {
  switch (typeof v) {
    case "boolean":
      return v ? 2 : 1;
    case "number":
      return 3;
    case "string":
      return 4;
    case "object":
      return v === null ? 0 : Array.isArray(v) ? 5 : 6;
    default:
      return 0;
  }
}

/** jq's total order: null < false < true < numbers < strings < arrays < objects. */
function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    // nan sorts below every number, itself included.
    return a < b ? -1 : a === b ? 0 : a > b ? 1 : Number.isNaN(a) ? -1 : 1;
  }
  if (typeof a === "string" && typeof b === "string") return compareStrings(a, b);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra < 5 || a === b) return 0;
  tick(1);
  if (ra === 5) {
    const x = a as unknown[];
    const y = b as unknown[];
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const c = compare(x[i], y[i]);
      if (c) return c;
    }
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
  }
  const x = a as Obj;
  const y = b as Obj;
  const kx = sortedKeys(x);
  const ky = sortedKeys(y);
  const n = Math.min(kx.length, ky.length);
  for (let i = 0; i < n; i++) {
    const c = compareStrings(kx[i], ky[i]);
    if (c) return c;
  }
  if (kx.length !== ky.length) return kx.length < ky.length ? -1 : 1;
  for (const k of kx) {
    const c = compare(x[k], y[k]);
    if (c) return c;
  }
  return 0;
}

function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return a == null && b == null;
  }
  tick(1);
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equals(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const x = a as Obj;
  const y = b as Obj;
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  for (const k of keys) {
    if (!Object.hasOwn(y, k) || !equals(x[k], y[k])) return false;
  }
  return true;
}

/** A number as jq 1.7 prints it (17 significant digits, `1e+17`, `1e-05`). */
function numberText(x: number): string {
  if (Number.isNaN(x)) return "null";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const a = Math.abs(x);
  if (a >= 1e-4 && a < 1e16) return String(x);
  if (a === Number.POSITIVE_INFINITY)
    return x > 0 ? "1.7976931348623157e+308" : "-1.7976931348623157e+308";
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(x.toExponential());
  if (!m) return String(x);
  const digits = m[2] + (m[3] ?? "");
  const point = Number(m[4]) + 1;
  if (point <= -4 || point > digits.length + 15) {
    const e = Math.abs(point - 1);
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${m[1]}${mantissa}e${point - 1 < 0 ? "-" : "+"}${e < 10 ? "0" : ""}${e}`;
  }
  if (point <= 0) return `${m[1]}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return m[1] + digits + "0".repeat(point - digits.length);
  return `${m[1]}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function quote(s: string): string {
  const q = JSON.stringify(s);
  return q.includes("\x7f") ? q.replaceAll("\x7f", "\\u007f") : q;
}

/** Writes JSON text into `out`; false when `budget.left` characters ran out. */
function writeJson(v: unknown, out: string[], budget: { left: number }): boolean {
  let s: string;
  switch (kind(v)) {
    case "null":
      s = "null";
      break;
    case "boolean":
      s = v ? "true" : "false";
      break;
    case "number":
      s = numberText(v as number);
      break;
    case "string": {
      const str = v as string;
      if (str.length > budget.left) {
        out.push(quote(str.slice(0, Math.max(budget.left, 0))));
        budget.left = -1;
        return false;
      }
      s = quote(str);
      break;
    }
    case "array": {
      const a = v as unknown[];
      tick(1);
      out.push("[");
      budget.left -= 2;
      for (let i = 0; i < a.length; i++) {
        if (i) {
          out.push(",");
          budget.left--;
        }
        if (!writeJson(a[i], out, budget)) return false;
      }
      out.push("]");
      return budget.left >= 0;
    }
    default: {
      const o = v as Obj;
      tick(1);
      out.push("{");
      budget.left -= 2;
      let first = true;
      for (const k of Object.keys(o)) {
        const key = `${first ? "" : ","}${quote(k)}:`;
        first = false;
        out.push(key);
        budget.left -= key.length;
        if (budget.left < 0 || !writeJson(o[k], out, budget)) return false;
      }
      out.push("}");
      return budget.left >= 0;
    }
  }
  out.push(s);
  budget.left -= s.length;
  return budget.left >= 0;
}

function toJson(v: unknown): string {
  if (typeof v === "string" && v.length <= strLimit) {
    const q = quote(v);
    checkLength(q.length);
    tick(q.length >> 4);
    return q;
  }
  const out: string[] = [];
  if (!writeJson(v, out, { left: strLimit })) checkLength(strLimit + 1);
  const s = out.join("");
  tick(s.length >> 4);
  return s;
}

/** A value for an error message, cut short as jq does. */
function dump(v: unknown): string {
  const out: string[] = [];
  writeJson(v, out, { left: 40 });
  const s = out.join("");
  return s.length > 14 ? `${s.slice(0, 11)}...` : s;
}

const describe = (v: unknown): string => `${kind(v)} (${dump(v)})`;

function toText(v: unknown): string {
  return typeof v === "string" ? v : toJson(v);
}

const SURROGATES = /[\uD800-\uDFFF]/;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Length in code points. */
function codePointLength(s: string): number {
  let n = s.length;
  if (n < 2 || !SURROGATES.test(s)) return n;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}

/** The UTF-16 offset of code point number `cp`, counting from `from` (at code point `fromCp`). */
function unitOffset(s: string, cp: number, from = 0, fromCp = 0): number {
  let i = from;
  let n = fromCp;
  while (n < cp && i < s.length) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    i++;
    n++;
  }
  return i;
}

/** Code points between two UTF-16 offsets. */
function codePointsBetween(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < to) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 2;
        i++;
      } else n += 2;
    } else n += 2;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Arithmetic

function add(a: unknown, b: unknown): unknown {
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (a == null) return b === undefined ? null : b;
  if (b == null) return a;
  if (typeof a === "string" && typeof b === "string") {
    checkLength(a.length + b.length);
    tick(b.length >> 4);
    return a + b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    tick(a.length + b.length);
    return a.concat(b);
  }
  if (isObj(a) && isObj(b)) {
    const out = { ...a };
    const keys = Object.keys(b);
    tick(Object.keys(a).length + keys.length);
    for (const k of keys) put(out, k, b[k]);
    return out;
  }
  return fail(`${describe(a)} and ${describe(b)} cannot be added`);
}

function subtract(a: unknown, b: unknown): unknown {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (Array.isArray(a) && Array.isArray(b)) {
    tick(a.length);
    return a.filter((x) => {
      for (const y of b) {
        tick(1);
        if (equals(x, y)) return false;
      }
      return true;
    });
  }
  return fail(`${describe(a)} and ${describe(b)} cannot be subtracted`);
}

function mergeDeep(a: Obj, b: Obj): Obj {
  const out = { ...a };
  const keys = Object.keys(b);
  tick(Object.keys(a).length + keys.length);
  for (const k of keys) {
    const x = Object.hasOwn(out, k) ? out[k] : null;
    const y = b[k];
    put(out, k, isObj(x) && isObj(y) ? mergeDeep(x, y) : y);
  }
  return out;
}

function repeatString(s: string, n: number): unknown {
  if (Number.isNaN(n) || n < 0) return null;
  const times = Math.trunc(n);
  checkLength(s.length * times);
  tick((s.length * times) >> 4);
  return s.repeat(times);
}

function multiply(a: unknown, b: unknown): unknown {
  if (typeof a === "number" && typeof b === "number") return a * b;
  if (typeof a === "string" && typeof b === "number") return repeatString(a, b);
  if (typeof a === "number" && typeof b === "string") return repeatString(b, a);
  if (isObj(a) && isObj(b)) return mergeDeep(a, b);
  return fail(`${describe(a)} and ${describe(b)} cannot be multiplied`);
}

function splitString(s: string, sep: string): string[] {
  if (s === "") return [];
  const parts = sep === "" ? Array.from(s) : s.split(sep);
  tick(parts.length + (s.length >> 6));
  return parts;
}

function divide(a: unknown, b: unknown): unknown {
  if (typeof a === "number" && typeof b === "number") {
    if (b === 0) {
      return fail(
        `${describe(a)} and ${describe(b)} cannot be divided because the divisor is zero`,
      );
    }
    return a / b;
  }
  if (typeof a === "string" && typeof b === "string") return splitString(a, b);
  return fail(`${describe(a)} and ${describe(b)} cannot be divided`);
}

const INT64_MAX = 9223372036854775807n;

/** A double as C's intmax_t: truncated and clamped. */
function toInt64(x: number): bigint {
  if (x >= 9223372036854775807) return INT64_MAX;
  if (x <= -9223372036854775808) return -INT64_MAX - 1n;
  return BigInt(Math.trunc(x));
}

function modulo(a: unknown, b: unknown): unknown {
  if (typeof a === "number" && typeof b === "number") {
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
    const safe = Math.abs(a) < 2 ** 53 && Math.abs(b) < 2 ** 53;
    const x = Math.trunc(a);
    const y = Math.trunc(b);
    if (y === 0) {
      return fail(
        `${describe(a)} and ${describe(b)} cannot be divided (remainder) because the divisor is zero`,
      );
    }
    // `|| 0`: integer arithmetic has no negative zero.
    if (safe) return x % y || 0;
    const bi = toInt64(b);
    return Number(bi === -1n ? 0n : toInt64(a) % bi);
  }
  return fail(`${describe(a)} and ${describe(b)} cannot be divided (remainder)`);
}

function negate(v: unknown): unknown {
  if (typeof v === "number") return -v;
  return fail(`${describe(v)} cannot be negated`);
}

type Binary = (a: unknown, b: unknown) => unknown;

const BINARY: Record<string, Binary> = {
  "+": add,
  "-": subtract,
  "*": multiply,
  "/": divide,
  "%": modulo,
  "==": (a, b) => equals(a, b),
  "!=": (a, b) => !equals(a, b),
  "<": (a, b) => compare(a, b) < 0,
  "<=": (a, b) => compare(a, b) <= 0,
  ">": (a, b) => compare(a, b) > 0,
  ">=": (a, b) => compare(a, b) >= 0,
};

// ---------------------------------------------------------------------------
// Indexing and paths

function iterate(v: unknown): unknown[] {
  if (Array.isArray(v)) {
    tick(v.length);
    return v;
  }
  if (isObj(v)) {
    const values = Object.values(v);
    tick(values.length);
    return values;
  }
  return fail(`Cannot iterate over ${v == null ? "null (null)" : describe(v)}`);
}

interface Slice {
  start: number;
  end: number;
}

/** The bounds of `{start, end}` on something of length `len`, as jq clamps them. */
function sliceBounds(len: number, key: Obj): Slice {
  const from = field(key, "start");
  const to = field(key, "end");
  if ((from !== null && typeof from !== "number") || (to !== null && typeof to !== "number")) {
    return fail("Start and end indices of an array slice must be numbers");
  }
  let start = from === null ? 0 : (from as number);
  let end = to === null ? len : (to as number);
  if (Number.isNaN(start)) start = 0;
  if (Number.isNaN(end)) end = len;
  if (start < 0) start += len;
  if (end < 0) end += len;
  if (start < 0) start = 0;
  if (start > len) start = len;
  if (end > len) end = len;
  if (end < start) end = start;
  return { start: Math.floor(start), end: Math.min(len, Math.ceil(end)) };
}

function sliceOf(v: unknown, key: Obj): unknown {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const { start, end } = sliceBounds(v.length, key);
    tick(end - start);
    return v.slice(start, end);
  }
  if (typeof v === "string") {
    if (!SURROGATES.test(v)) {
      const { start, end } = sliceBounds(v.length, key);
      return v.slice(start, end);
    }
    const { start, end } = sliceBounds(codePointLength(v), key);
    const from = unitOffset(v, start);
    return v.slice(from, unitOffset(v, end, from, start));
  }
  return fail(`Cannot index ${kind(v)} with object`);
}

/** Where each occurrence of `sub` starts in `arr`. */
function arrayIndices(arr: unknown[], sub: unknown[]): number[] {
  const out: number[] = [];
  if (!sub.length) return out;
  tick(arr.length);
  for (let i = 0; i + sub.length <= arr.length; i++) {
    let hit = true;
    for (let j = 0; j < sub.length; j++) {
      if (!equals(arr[i + j], sub[j])) {
        hit = false;
        break;
      }
    }
    if (hit) out.push(i);
  }
  return out;
}

/** `v[k]` for any key jq accepts. */
function index(v: unknown, k: unknown): unknown {
  if (typeof k === "string") {
    if (isObj(v)) return field(v, k);
    if (v == null) return null;
    return fail(`Cannot index ${kind(v)} with "${k}"`);
  }
  if (typeof k === "number") {
    if (Array.isArray(v)) {
      let i = Math.trunc(k);
      if (i < 0) i += v.length;
      const x = v[i];
      return x === undefined ? null : x;
    }
    if (v == null) return null;
    return fail(`Cannot index ${kind(v)} with number`);
  }
  if (isObj(k) && (v == null || Array.isArray(v) || typeof v === "string")) return sliceOf(v, k);
  if (Array.isArray(k) && Array.isArray(v)) return arrayIndices(v, k);
  return fail(`Cannot index ${kind(v)} with ${kind(k)}`);
}

function getPath(v: unknown, path: Path): unknown {
  let cur = v;
  for (const k of path) {
    if (cur == null) return null;
    cur = index(cur, k);
  }
  return cur === undefined ? null : cur;
}

/** The containers a path update may change in place: the ones it copied itself. */
interface Owner {
  epoch: number;
  tags: WeakMap<object, number>;
}

const newOwner = (): Owner => ({ epoch: 1, tags: new WeakMap() });
const owns = (own: Owner | null, c: object): boolean =>
  own !== null && own.tags.get(c) === own.epoch;

/** `c` if `own` holds it, else a shallow copy that it now holds. */
function mine<T extends object>(c: T, own: Owner | null): T {
  if (owns(own, c)) return c;
  let copy: T;
  if (Array.isArray(c)) {
    tick(c.length);
    copy = c.slice() as T;
  } else {
    tick(Object.keys(c).length);
    copy = { ...c };
  }
  own?.tags.set(copy, own.epoch);
  return copy;
}

/** `root` with `key` set to `value`. Changes `root` itself only when `own` holds it. */
function setKey(root: unknown, key: unknown, value: unknown, own: Owner | null): unknown {
  if (typeof key === "string") {
    if (root != null && !isObj(root)) return fail(`Cannot index ${kind(root)} with "${key}"`);
    if (root == null) {
      const o: Obj = {};
      own?.tags.set(o, own.epoch);
      put(o, key, value);
      return o;
    }
    if (Object.hasOwn(root, key) && root[key] === value) return root;
    const o = mine(root, own);
    put(o, key, value);
    return o;
  }
  if (typeof key === "number") {
    if (root != null && !Array.isArray(root)) return fail(`Cannot index ${kind(root)} with number`);
    const len = root == null ? 0 : root.length;
    let i = Math.trunc(key);
    if (Number.isNaN(i)) i = 0;
    if (i < 0) {
      i += len;
      if (i < 0) return fail("Out of bounds negative array index");
    }
    if (root != null && i < len && root[i] === value) return root;
    if (i > 0x1fffffff) return fail("Array index too large");
    if (i > len) tick(i - len);
    let a: unknown[];
    if (root == null) {
      a = [];
      own?.tags.set(a, own.epoch);
    } else a = mine(root, own);
    while (a.length < i) a.push(null);
    a[i] = value;
    return a;
  }
  if (isObj(key)) {
    if (root != null && !Array.isArray(root))
      return fail(`Cannot update field at object index of ${kind(root)}`);
    if (!Array.isArray(value))
      return fail("A slice of an array can only be assigned another array");
    const src: unknown[] = root ?? [];
    const { start, end } = sliceBounds(src.length, key);
    tick(src.length + value.length);
    const a = src.slice(0, start);
    for (const x of value) a.push(x);
    for (let i = end; i < src.length; i++) a.push(src[i]);
    own?.tags.set(a, own.epoch);
    return a;
  }
  if (Array.isArray(key) && Array.isArray(root))
    return fail("Cannot update field at array index of array");
  return fail(`Cannot index ${kind(root)} with ${kind(key)}`);
}

function setPath(root: unknown, path: Path, i: number, value: unknown, own: Owner | null): unknown {
  if (i === path.length) return value;
  const key = path[i];
  const child = root == null ? null : index(root, key);
  return setKey(root, key, setPath(child, path, i + 1, value, own), own);
}

/** After `path` was written under `root`: only the containers along it stay held. */
function keepOnly(own: Owner, root: unknown, path: Path): void {
  own.epoch++;
  let c = root;
  for (let i = 0; i < path.length && isContainer(c); i++) {
    own.tags.set(c, own.epoch);
    const k = path[i];
    if (typeof k === "string" && isObj(c)) c = Object.hasOwn(c, k) ? c[k] : null;
    else if (typeof k === "number" && Array.isArray(c))
      c = c[k < 0 ? c.length + Math.trunc(k) : Math.trunc(k)];
    else break;
  }
}

function deleteKeys(v: unknown, keys: unknown[]): unknown {
  if (v == null || !keys.length) return v;
  if (Array.isArray(v)) {
    const gone = new Set<number>();
    const ranges: Slice[] = [];
    for (const k of keys) {
      if (typeof k === "number") gone.add(k < 0 ? v.length + Math.trunc(k) : Math.trunc(k));
      else if (isObj(k)) ranges.push(sliceBounds(v.length, k));
      else return fail(`Cannot delete field at object index of array`);
    }
    tick(v.length);
    return v.filter((_, i) => !gone.has(i) && !ranges.some((r) => r.start <= i && i < r.end));
  }
  if (isObj(v)) {
    let out: Obj | null = null;
    for (const k of keys) {
      if (typeof k !== "string") return fail("Cannot delete field at array index of object");
      if (!Object.hasOwn(out ?? v, k)) continue;
      if (!out) {
        tick(Object.keys(v).length);
        out = { ...v };
      }
      delete out[k];
    }
    return out ?? v;
  }
  return fail(`Cannot delete fields from ${kind(v)}`);
}

/** Deletes sorted `paths[from..to)`, all of which agree up to `depth`. */
function deleteSorted(v: unknown, paths: Path[], from: number, to: number, depth: number): unknown {
  let out = v;
  const direct: unknown[] = [];
  let i = from;
  while (i < to) {
    const key = paths[i][depth];
    let j = i + 1;
    while (j < to && equals(paths[j][depth], key)) j++;
    if (paths[i].length === depth + 1) {
      direct.push(key);
    } else {
      const child = out == null ? null : index(out, key);
      if (child !== null) {
        const next = deleteSorted(child, paths, i, j, depth + 1);
        if (next !== child) out = setKey(out, key, next, null);
      }
    }
    i = j;
  }
  return deleteKeys(out, direct);
}

function deletePaths(v: unknown, paths: unknown): unknown {
  if (!Array.isArray(paths)) return fail("Paths must be specified as an array");
  for (const p of paths) {
    if (!Array.isArray(p)) return fail(`Path must be specified as array, not ${kind(p)}`);
  }
  if (!paths.length) return v;
  tick(paths.length);
  const sorted = (paths as Path[]).slice().sort(compare);
  if (!sorted[0].length) return null;
  return deleteSorted(v, sorted, 0, sorted.length, 0);
}

function has(v: unknown, k: unknown): boolean {
  if (isObj(v) && typeof k === "string") return Object.hasOwn(v, k);
  if (Array.isArray(v) && typeof k === "number") return k >= 0 && k < v.length;
  return fail(`Cannot check whether ${kind(v)} has a ${kind(k)} key`);
}

function keysOf(v: unknown, sorted: boolean): unknown[] {
  if (isObj(v)) {
    const keys = sorted ? sortedKeys(v) : Object.keys(v);
    tick(keys.length);
    return keys;
  }
  if (Array.isArray(v)) {
    tick(v.length);
    return v.map((_, i) => i);
  }
  return fail(`${describe(v)} has no keys`);
}

function lengthOf(v: unknown): unknown {
  switch (kind(v)) {
    case "null":
      return 0;
    case "boolean":
      return fail(`${describe(v)} has no length`);
    case "number":
      return Math.abs(v as number);
    case "string":
      return codePointLength(v as string);
    case "array":
      return (v as unknown[]).length;
    default:
      return Object.keys(v as Obj).length;
  }
}

/** jq's `contains`: strings by substring, arrays and objects member by member. */
function contains(a: unknown, b: unknown): boolean {
  tick(1);
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(b)) {
      if (!Object.hasOwn(a, k) || !contains(a[k], b[k])) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return b.every((y) => a.some((x) => contains(x, y)));
  }
  if (typeof a === "string" && typeof b === "string") return a.includes(b);
  return rank(a) === rank(b) && equals(a, b);
}

// ---------------------------------------------------------------------------
// Tokens

interface Tok {
  /** num, str, id (names and keywords), field (.name), var ($name), fmt (@name), op or eof. */
  k: "num" | "str" | "id" | "field" | "var" | "fmt" | "op" | "eof";
  v: string;
  pos: number;
  num?: number;
  /** A string's text and the tokens of each `\(...)` in it. */
  parts?: (string | Tok[])[];
}

const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME = /[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/y;
const SIMPLE_NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const FORMAT_NAME = /[A-Za-z0-9_]+/y;
const SPACE = /(?:\s+|#[^\n]*)+/y;
const LONG_OPS = [
  "?//",
  "//=",
  "|=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "==",
  "!=",
  "<=",
  ">=",
  "//",
  "..",
];
const SHORT_OPS = ".[]{}()|,:;=<>+-*/%?";
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function syntaxError(message: string, pos: number): JqError {
  return new JqError(`jq: syntax error at offset ${pos}: ${message}`, pos);
}

function unsupported(name: string, pos: number): JqError {
  return new JqError(`not supported in Encela's jq subset: ${name}`, pos);
}

function matchAt(re: RegExp, src: string, pos: number): string | null {
  re.lastIndex = pos;
  const m = re.exec(src);
  return m ? m[0] : null;
}

/** A string literal starting at its opening quote. */
function lexString(src: string, start: number, nested: number): { tok: Tok; end: number } {
  const parts: (string | Tok[])[] = [];
  let text = "";
  let i = start + 1;
  for (;;) {
    if (i >= src.length) throw syntaxError("the string is not closed", start);
    const c = src[i];
    if (c === '"') break;
    if (c !== "\\") {
      let j = i + 1;
      while (j < src.length && src[j] !== '"' && src[j] !== "\\") j++;
      text += src.slice(i, j);
      i = j;
      continue;
    }
    const e = src[i + 1];
    if (e === "(") {
      if (nested >= MAX_NESTING) throw syntaxError("the program is nested too deeply", i);
      const inner = lex(src, i + 2, nested + 1);
      parts.push(text.replace(LONE_SURROGATES, "�"), inner.toks);
      text = "";
      i = inner.end + 1;
    } else if (e === "u") {
      const hex = src.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw syntaxError("invalid \\u escape in a string", i);
      text += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
    } else if (e !== undefined && Object.hasOwn(ESCAPES, e)) {
      text += ESCAPES[e];
      i += 2;
    } else {
      throw syntaxError("invalid escape in a string", i);
    }
  }
  parts.push(text.replace(LONE_SURROGATES, "�"));
  return { tok: { k: "str", v: "", pos: start, parts }, end: i + 1 };
}

/** Tokens from `start`. Inside a string (`nested` > 0) they end at the `)` that closes `\(`. */
function lex(src: string, start: number, nested: number): { toks: Tok[]; end: number } {
  const toks: Tok[] = [];
  let parens = 0;
  let i = start;
  for (;;) {
    const gap = matchAt(SPACE, src, i);
    if (gap) i += gap.length;
    if (i >= src.length) {
      if (nested) throw syntaxError("the string interpolation is not closed", start);
      toks.push({ k: "eof", v: "", pos: i });
      return { toks, end: i };
    }
    const c = src[i];
    const d = src[i + 1] ?? "";
    if (c === '"') {
      const s = lexString(src, i, nested);
      toks.push(s.tok);
      i = s.end;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && d >= "0" && d <= "9")) {
      const text = matchAt(NUMBER, src, i) ?? c;
      toks.push({ k: "num", v: text, pos: i, num: Number(text) });
      i += text.length;
      continue;
    }
    if (c === "." || c === "$" || c === "@") {
      const name = matchAt(c === "@" ? FORMAT_NAME : SIMPLE_NAME, src, i + 1);
      if (name) {
        toks.push({ k: c === "." ? "field" : c === "$" ? "var" : "fmt", v: name, pos: i });
        i += 1 + name.length;
        continue;
      }
      if (c !== ".") throw syntaxError(`unexpected "${c}"`, i);
    }
    const name = matchAt(NAME, src, i);
    if (name) {
      if (name.includes("::")) throw unsupported("modules", i);
      toks.push({ k: "id", v: name, pos: i });
      i += name.length;
      continue;
    }
    const op = LONG_OPS.find((o) => src.startsWith(o, i)) ?? (SHORT_OPS.includes(c) ? c : null);
    if (!op) throw syntaxError(`unexpected character ${JSON.stringify(c)}`, i);
    if (op === "(") parens++;
    if (op === ")") {
      if (nested && parens === 0) {
        toks.push({ k: "eof", v: "", pos: i });
        return { toks, end: i };
      }
      parens--;
    }
    toks.push({ k: "op", v: op, pos: i });
    i += op.length;
  }
}

// ---------------------------------------------------------------------------
// Syntax tree

interface Param {
  name: string;
  /** Declared as `$name`: bound to a value, not a filter. */
  isVar: boolean;
}

type Pattern =
  | { t: "pvar"; name: string }
  | { t: "parr"; items: Pattern[] }
  | { t: "pobj"; entries: { name: string | null; key: Node | null; value: Pattern | null }[] };

interface DefHead {
  pos: number;
  name: string;
  params: Param[];
  body: Node;
}

interface Pair<T extends string> {
  t: T;
  pos: number;
  l: Node;
  r: Node;
}

interface Operation<T extends string> extends Pair<T> {
  op: string;
}

type Node =
  | { t: "id"; pos: number }
  | { t: "rec"; pos: number }
  | { t: "lit"; pos: number; v: unknown }
  | { t: "str"; pos: number; parts: (string | Node)[]; fmt: string | null }
  | { t: "fmt"; pos: number; name: string }
  | { t: "idx"; pos: number; of: Node; key: Node }
  | { t: "slice"; pos: number; of: Node; from: Node | null; to: Node | null }
  | { t: "iter"; pos: number; of: Node }
  | { t: "arr"; pos: number; body: Node | null }
  | { t: "obj"; pos: number; entries: { key: Node; value: Node }[] }
  | { t: "neg"; pos: number; of: Node }
  | Pair<"pipe">
  | Pair<"comma">
  | Pair<"and">
  | Pair<"or">
  | Pair<"alt">
  | Operation<"bin">
  | Operation<"assign">
  | { t: "if"; pos: number; cond: Node; then: Node; else: Node | null }
  | { t: "try"; pos: number; body: Node; handler: Node | null }
  | { t: "reduce"; pos: number; src: Node; pat: Pattern; init: Node; update: Node }
  | {
      t: "foreach";
      pos: number;
      src: Node;
      pat: Pattern;
      init: Node;
      update: Node;
      extract: Node | null;
    }
  | ({ t: "def"; rest: Node } & DefHead)
  | { t: "call"; pos: number; name: string; args: Node[] }
  | { t: "var"; pos: number; name: string }
  | { t: "loc"; pos: number; line: number }
  | { t: "as"; pos: number; src: Node; pat: Pattern; body: Node }
  | { t: "label"; pos: number; name: string; body: Node }
  | { t: "break"; pos: number; name: string };

const ASSIGN_OPS = new Set(["=", "|=", "+=", "-=", "*=", "/=", "%=", "//="]);
const COMPARE_OPS = new Set(["==", "!=", "<", "<=", ">", ">="]);
/** Words that cannot start a term. */
const CLOSERS = new Set(["then", "elif", "else", "end", "as", "catch", "and", "or", "__loc__"]);

// ---------------------------------------------------------------------------
// Parser: recursive descent with jq's precedence, lowest first:
// `|`, `,`, `//` (right), assignment (none), or, and, comparison (none), + -, * / %.

class Parser {
  private p = 0;

  constructor(
    private readonly src: string,
    private readonly toks: Tok[],
    private depth = 0,
  ) {}

  program(): Node {
    const n = this.pipe();
    if (this.peek().k !== "eof") throw this.unexpected(this.peek());
    return n;
  }

  /** A list of `def`s and nothing else (the prelude). */
  defs(): DefHead[] {
    const out: DefHead[] = [];
    while (this.isWord("def")) out.push(this.defHead());
    if (this.peek().k !== "eof") throw this.unexpected(this.peek());
    return out;
  }

  private peek(): Tok {
    return this.toks[this.p];
  }

  private next(): Tok {
    const tok = this.toks[this.p];
    if (tok.k !== "eof") this.p++;
    return tok;
  }

  private isOp(v: string): boolean {
    const tok = this.toks[this.p];
    return tok.k === "op" && tok.v === v;
  }

  private isWord(v: string): boolean {
    const tok = this.toks[this.p];
    return tok.k === "id" && tok.v === v;
  }

  private eat(v: string): boolean {
    if (!this.isOp(v)) return false;
    this.p++;
    return true;
  }

  private show(tok: Tok): string {
    if (tok.k === "eof") return "the end of the program";
    if (tok.k === "str") return "a string";
    const prefix = tok.k === "field" ? "." : tok.k === "var" ? "$" : tok.k === "fmt" ? "@" : "";
    return JSON.stringify(prefix + tok.v);
  }

  private unexpected(tok: Tok, wanted = ""): JqError {
    return syntaxError(`unexpected ${this.show(tok)}${wanted && `, expected ${wanted}`}`, tok.pos);
  }

  private expectOp(v: string): Tok {
    const tok = this.next();
    if (tok.k !== "op" || tok.v !== v) throw this.unexpected(tok, JSON.stringify(v));
    return tok;
  }

  private expectWord(v: string): Tok {
    const tok = this.next();
    if (tok.k !== "id" || tok.v !== v) throw this.unexpected(tok, JSON.stringify(v));
    return tok;
  }

  private deeper(): void {
    this.depth++;
    if (this.depth > MAX_NESTING) {
      throw syntaxError("the program is nested too deeply", this.peek().pos);
    }
  }

  private pipe(): Node {
    this.deeper();
    const heads: DefHead[] = [];
    while (this.isWord("def")) heads.push(this.defHead());
    const parts = [this.comma()];
    while (this.eat("|")) {
      // A `def` after `|` takes the rest of the pipeline.
      parts.push(this.isWord("def") ? this.pipe() : this.comma());
    }
    let out = parts[parts.length - 1];
    for (let i = parts.length - 2; i >= 0; i--) {
      out = { t: "pipe", pos: parts[i].pos, l: parts[i], r: out };
    }
    for (let i = heads.length - 1; i >= 0; i--) out = { t: "def", ...heads[i], rest: out };
    this.depth--;
    return out;
  }

  private defHead(): DefHead {
    const pos = this.next().pos;
    const name = this.next();
    if (name.k !== "id") throw this.unexpected(name, "a function name");
    const params: Param[] = [];
    if (this.eat("(")) {
      do {
        const tok = this.next();
        if (tok.k !== "id" && tok.k !== "var") throw this.unexpected(tok, "a parameter name");
        params.push({ name: tok.v, isVar: tok.k === "var" });
      } while (this.eat(";"));
      this.expectOp(")");
    }
    this.expectOp(":");
    const body = this.pipe();
    this.expectOp(";");
    return { pos, name: name.v, params, body };
  }

  private comma(): Node {
    let l = this.alt();
    while (this.isOp(",")) {
      const pos = this.next().pos;
      l = { t: "comma", pos, l, r: this.alt() };
    }
    return l;
  }

  private alt(): Node {
    const l = this.assign();
    if (!this.isOp("//")) return l;
    const pos = this.next().pos;
    return { t: "alt", pos, l, r: this.alt() };
  }

  private assign(): Node {
    const l = this.or();
    const tok = this.peek();
    if (tok.k !== "op" || !ASSIGN_OPS.has(tok.v)) return l;
    this.p++;
    const r = this.or();
    const after = this.peek();
    if (after.k === "op" && ASSIGN_OPS.has(after.v)) throw this.unexpected(after);
    return { t: "assign", pos: tok.pos, op: tok.v, l, r };
  }

  private or(): Node {
    let l = this.and();
    while (this.isWord("or")) {
      const pos = this.next().pos;
      l = { t: "or", pos, l, r: this.and() };
    }
    return l;
  }

  private and(): Node {
    let l = this.comparison();
    while (this.isWord("and")) {
      const pos = this.next().pos;
      l = { t: "and", pos, l, r: this.comparison() };
    }
    return l;
  }

  private comparison(): Node {
    const l = this.sum();
    const tok = this.peek();
    if (tok.k !== "op" || !COMPARE_OPS.has(tok.v)) return l;
    this.p++;
    const r = this.sum();
    const after = this.peek();
    if (after.k === "op" && COMPARE_OPS.has(after.v)) throw this.unexpected(after);
    return { t: "bin", pos: tok.pos, op: tok.v, l, r };
  }

  private sum(): Node {
    let l = this.product();
    for (;;) {
      const tok = this.peek();
      if (tok.k !== "op" || (tok.v !== "+" && tok.v !== "-")) return l;
      this.p++;
      l = { t: "bin", pos: tok.pos, op: tok.v, l, r: this.product() };
    }
  }

  private product(): Node {
    let l = this.unary();
    for (;;) {
      const tok = this.peek();
      if (tok.k !== "op" || (tok.v !== "*" && tok.v !== "/" && tok.v !== "%")) return l;
      this.p++;
      l = { t: "bin", pos: tok.pos, op: tok.v, l, r: this.unary() };
    }
  }

  private unary(): Node {
    if (!this.isOp("-")) return this.postfix(true);
    const pos = this.next().pos;
    this.deeper();
    const of = this.product();
    this.depth--;
    return { t: "neg", pos, of };
  }

  /** A term and what follows it directly: fields, brackets, `?`, and `as` bindings. */
  private postfix(allowAs: boolean): Node {
    let e = this.primary();
    for (;;) {
      const tok = this.peek();
      if (tok.k === "field") {
        this.p++;
        e = { t: "idx", pos: tok.pos, of: e, key: { t: "lit", pos: tok.pos, v: tok.v } };
      } else if (tok.k === "op" && tok.v === ".") {
        const after = this.toks[this.p + 1];
        if (after.k === "str") {
          this.p += 2;
          e = { t: "idx", pos: tok.pos, of: e, key: this.string(after, null) };
        } else if (after.k === "op" && after.v === "[") {
          this.p++;
        } else {
          return e;
        }
      } else if (tok.k === "op" && tok.v === "[") {
        this.p++;
        e = this.bracket(e, tok.pos);
      } else if (tok.k === "op" && tok.v === "?") {
        this.p++;
        e = { t: "try", pos: tok.pos, body: e, handler: null };
      } else if (tok.k === "op" && tok.v === "?//") {
        // `.a?//b` is `.a? // b` here (jq 1.7 takes `?//` as one token and fails).
        e = { t: "try", pos: tok.pos, body: e, handler: null };
        this.toks[this.p] = { k: "op", v: "//", pos: tok.pos + 1 };
      } else if (allowAs && tok.k === "id" && tok.v === "as") {
        this.p++;
        const pat = this.patterns();
        this.expectOp("|");
        return { t: "as", pos: tok.pos, src: e, pat, body: this.pipe() };
      } else {
        return e;
      }
    }
  }

  /** What follows `[` after a term: `]`, an index or a slice. */
  private bracket(of: Node, pos: number): Node {
    if (this.eat("]")) return { t: "iter", pos, of };
    if (this.eat(":")) {
      const to = this.pipe();
      this.expectOp("]");
      return { t: "slice", pos, of, from: null, to };
    }
    const first = this.pipe();
    if (this.eat(":")) {
      if (this.eat("]")) return { t: "slice", pos, of, from: first, to: null };
      const to = this.pipe();
      this.expectOp("]");
      return { t: "slice", pos, of, from: first, to };
    }
    this.expectOp("]");
    return { t: "idx", pos, of, key: first };
  }

  private primary(): Node {
    const tok = this.next();
    const pos = tok.pos;
    switch (tok.k) {
      case "num":
        return { t: "lit", pos, v: tok.num };
      case "str":
        return this.string(tok, null);
      case "fmt":
        if (this.peek().k === "str") return this.string(this.next(), tok.v);
        return { t: "fmt", pos, name: tok.v };
      case "field":
        return { t: "idx", pos, of: { t: "id", pos }, key: { t: "lit", pos, v: tok.v } };
      case "var":
        if (tok.v === "__loc__") return { t: "loc", pos, line: this.line(pos) };
        return { t: "var", pos, name: tok.v };
      case "op":
        return this.punctuated(tok);
      case "id":
        return this.word(tok);
      default:
        throw this.unexpected(tok);
    }
  }

  private punctuated(tok: Tok): Node {
    const pos = tok.pos;
    switch (tok.v) {
      case ".":
        if (this.peek().k === "str") {
          return { t: "idx", pos, of: { t: "id", pos }, key: this.string(this.next(), null) };
        }
        return { t: "id", pos };
      case "..":
        return { t: "rec", pos };
      case "(": {
        const e = this.pipe();
        this.expectOp(")");
        return e;
      }
      case "[": {
        if (this.eat("]")) return { t: "arr", pos, body: null };
        const body = this.pipe();
        this.expectOp("]");
        return { t: "arr", pos, body };
      }
      case "{":
        return this.object(pos);
      case "-": {
        this.deeper();
        const of = this.postfix(true);
        this.depth--;
        return { t: "neg", pos, of };
      }
      default:
        throw this.unexpected(tok);
    }
  }

  private word(tok: Tok): Node {
    const pos = tok.pos;
    switch (tok.v) {
      case "def":
        this.p--;
        return this.pipe();
      case "if":
        return this.conditional(pos);
      case "try": {
        const body = this.postfix(true);
        let handler: Node | null = null;
        if (this.isWord("catch")) {
          this.p++;
          handler = this.postfix(true);
        }
        return { t: "try", pos, body, handler };
      }
      case "reduce":
      case "foreach": {
        const src = this.postfix(false);
        this.expectWord("as");
        const pat = this.patterns();
        this.expectOp("(");
        const init = this.pipe();
        this.expectOp(";");
        const update = this.pipe();
        let extract: Node | null = null;
        if (tok.v === "foreach" && this.eat(";")) extract = this.pipe();
        this.expectOp(")");
        if (tok.v === "reduce") return { t: "reduce", pos, src, pat, init, update };
        return { t: "foreach", pos, src, pat, init, update, extract };
      }
      case "label": {
        const name = this.next();
        if (name.k !== "var") throw this.unexpected(name, "a $label");
        this.expectOp("|");
        return { t: "label", pos, name: name.v, body: this.pipe() };
      }
      case "break": {
        const name = this.next();
        if (name.k !== "var") throw this.unexpected(name, "a $label");
        return { t: "break", pos, name: name.v };
      }
      case "import":
      case "include":
        throw unsupported(tok.v, pos);
      case "null":
        return { t: "lit", pos, v: null };
      case "true":
        return { t: "lit", pos, v: true };
      case "false":
        return { t: "lit", pos, v: false };
    }
    if (CLOSERS.has(tok.v)) throw this.unexpected(tok);
    const args: Node[] = [];
    if (this.eat("(")) {
      do args.push(this.pipe());
      while (this.eat(";"));
      this.expectOp(")");
    }
    return { t: "call", pos, name: tok.v, args };
  }

  private conditional(pos: number): Node {
    const cond = this.pipe();
    this.expectWord("then");
    const then = this.pipe();
    const tok = this.next();
    let otherwise: Node | null = null;
    if (tok.k === "id" && tok.v === "elif") {
      otherwise = this.conditional(tok.pos);
    } else if (tok.k === "id" && tok.v === "else") {
      otherwise = this.pipe();
      this.expectWord("end");
    } else if (tok.k !== "id" || tok.v !== "end") {
      throw this.unexpected(tok, '"elif", "else" or "end"');
    }
    return { t: "if", pos, cond, then, else: otherwise };
  }

  private object(pos: number): Node {
    const entries: { key: Node; value: Node }[] = [];
    if (this.eat("}")) return { t: "obj", pos, entries };
    do {
      const tok = this.next();
      const at = tok.pos;
      let key: Node;
      let value: Node | null = null;
      const self = (k: Node): Node | null =>
        this.isOp(":") ? null : { t: "idx", pos: at, of: { t: "id", pos: at }, key: k };
      if (tok.k === "var") {
        if (tok.v === "__loc__") {
          key = { t: "lit", pos: at, v: "__loc__" };
          value = { t: "loc", pos: at, line: this.line(at) };
        } else if (this.isOp(":")) {
          // `{$x: v}`: the value of $x is the key.
          key = { t: "var", pos: at, name: tok.v };
        } else {
          key = { t: "lit", pos: at, v: tok.v };
          value = { t: "var", pos: at, name: tok.v };
        }
      } else if (tok.k === "id") {
        key = { t: "lit", pos: at, v: tok.v };
        value = self(key);
      } else if (tok.k === "str") {
        key = this.string(tok, null);
        value = self(key);
      } else if (tok.k === "fmt" && this.peek().k === "str") {
        key = this.string(this.next(), tok.v);
        value = self(key);
      } else if (tok.k === "op" && tok.v === "(") {
        key = this.pipe();
        this.expectOp(")");
      } else if (tok.k === "num") {
        throw syntaxError("object keys must be strings: put the key expression in parentheses", at);
      } else {
        throw this.unexpected(tok, "an object key");
      }
      if (!value) {
        this.expectOp(":");
        value = this.objectValue();
      }
      entries.push({ key, value });
    } while (this.eat(","));
    this.expectOp("}");
    return { t: "obj", pos, entries };
  }

  /** jq takes only terms and `|` here; any expression without a bare comma is read. */
  private objectValue(): Node {
    const l = this.alt();
    if (!this.isOp("|")) return l;
    const pos = this.next().pos;
    return { t: "pipe", pos, l, r: this.objectValue() };
  }

  private string(tok: Tok, fmt: string | null): Node {
    const parts = (tok.parts ?? []).map((part) =>
      typeof part === "string" ? part : new Parser(this.src, part, this.depth + 1).program(),
    );
    if (parts.length === 1) return { t: "lit", pos: tok.pos, v: parts[0] };
    return { t: "str", pos: tok.pos, parts, fmt };
  }

  private patterns(): Pattern {
    const pat = this.pattern();
    if (this.isOp("?//")) throw unsupported("?//", this.peek().pos);
    return pat;
  }

  private pattern(): Pattern {
    const tok = this.next();
    if (tok.k === "var") return { t: "pvar", name: tok.v };
    this.deeper();
    let out: Pattern;
    if (tok.k === "op" && tok.v === "[") {
      const items: Pattern[] = [];
      do items.push(this.pattern());
      while (this.eat(","));
      this.expectOp("]");
      out = { t: "parr", items };
    } else if (tok.k === "op" && tok.v === "{") {
      const entries: { name: string | null; key: Node | null; value: Pattern | null }[] = [];
      do {
        const k = this.next();
        if (k.k === "var") {
          entries.push({ name: k.v, key: null, value: this.eat(":") ? this.pattern() : null });
          continue;
        }
        let key: Node;
        if (k.k === "id") key = { t: "lit", pos: k.pos, v: k.v };
        else if (k.k === "str") key = this.string(k, null);
        else if (k.k === "fmt" && this.peek().k === "str") key = this.string(this.next(), k.v);
        else if (k.k === "op" && k.v === "(") {
          key = this.pipe();
          this.expectOp(")");
        } else throw this.unexpected(k, "a key to destructure");
        this.expectOp(":");
        entries.push({ name: null, key, value: this.pattern() });
      } while (this.eat(","));
      this.expectOp("}");
      out = { t: "pobj", entries };
    } else {
      throw this.unexpected(tok, "a $variable, [ or {");
    }
    this.depth--;
    return out;
  }

  private line(pos: number): number {
    let n = 1;
    for (let i = this.src.indexOf("\n"); i >= 0 && i < pos; i = this.src.indexOf("\n", i + 1)) n++;
    return n;
  }
}

function parse(source: string): Node {
  return new Parser(source, lex(source, 0, 0).toks).program();
}

// ---------------------------------------------------------------------------
// Compiled code. Each syntax node becomes a `Code`: closures over its
// children. Variables and filter arguments live in a linked list of frames;
// where each one sits is worked out when compiling.

interface Frame {
  readonly v: unknown;
  readonly up: Frame | null;
}
type Env = Frame | null;

type One = (input: unknown, env: Env) => unknown;
type All = (input: unknown, env: Env) => Iterable<unknown>;

/** An output and the path that leads to it; `p` is null when it is not a path into the input. */
interface PathValue {
  p: Path | null;
  v: unknown;
}
type Paths = (input: unknown, path: Path | null, env: Env) => Iterable<PathValue>;

class Code {
  private lazyPaths: Paths | null = null;

  constructor(
    /** For code that gives at most one output: that output or NONE. */
    readonly one: One | null,
    /** Every output, lazily. */
    readonly all: All,
    private readonly makePaths: (() => Paths) | null = null,
  ) {}

  /** The outputs as paths, for `path(f)` and the assignment operators. */
  get paths(): Paths {
    if (!this.lazyPaths) this.lazyPaths = this.makePaths ? this.makePaths() : this.valuePaths();
    return this.lazyPaths;
  }

  /** Not a path expression: an output is a path only when it is the input itself. */
  private valuePaths(): Paths {
    const { one, all } = this;
    if (one) {
      return (input, path, env) => {
        const v = one(input, env);
        return v === NONE ? NO_PATHS : [{ p: v === input ? path : null, v }];
      };
    }
    return function* (input, path, env) {
      for (const v of all(input, env)) yield { p: v === input ? path : null, v };
    };
  }
}

/** A filter argument: code and the frames it was written in. */
interface Closure {
  code: Code;
  env: Env;
}

const EMPTY: readonly unknown[] = [];
const NO_PATHS: readonly PathValue[] = [];

function single(one: One, makePaths: (() => Paths) | null = null): Code {
  return new Code(
    one,
    (i, e) => {
      const v = one(i, e);
      return v === NONE ? EMPTY : [v];
    },
    makePaths,
  );
}

function many(all: All, makePaths: (() => Paths) | null = null): Code {
  return new Code(null, all, makePaths);
}

const IDENTITY = new Code(
  (i) => i,
  (i) => [i],
  () => (input, path) => [{ p: path, v: input }],
);

function at(env: Env, hops: number): unknown {
  let e = env as Frame;
  for (let i = hops; i > 0; i--) e = e.up as Frame;
  return e.v;
}

function firstOf(code: Code, input: unknown, env: Env): unknown {
  if (code.one) return code.one(input, env);
  for (const v of code.all(input, env)) return v;
  return NONE;
}

function notPath(v: unknown): never {
  return fail(`Invalid path expression with result ${dump(v)}`);
}

function extend(pv: PathValue, key: unknown): Path {
  if (!pv.p) {
    return fail(
      `Invalid path expression near attempt to access element ${dump(key)} of ${dump(pv.v)}`,
    );
  }
  return [...pv.p, key];
}

// --- Combinators, shared by the compiler and the builtins ------------------

function pipeOf(l: Code, r: Code): Code {
  const lo = l.one;
  const ro = r.one;
  const paths = (): Paths =>
    function* (input, path, env) {
      for (const pv of l.paths(input, path, env)) yield* r.paths(pv.v, pv.p, env);
    };
  if (lo && ro) {
    return single((i, e) => {
      const v = lo(i, e);
      return v === NONE ? NONE : ro(v, e);
    }, paths);
  }
  if (lo) {
    return many((i, e) => {
      const v = lo(i, e);
      return v === NONE ? EMPTY : r.all(v, e);
    }, paths);
  }
  if (ro) {
    return many(function* (i, e) {
      for (const v of l.all(i, e)) {
        const w = ro(v, e);
        if (w !== NONE) yield w;
      }
    }, paths);
  }
  return many(function* (i, e) {
    for (const v of l.all(i, e)) yield* r.all(v, e);
  }, paths);
}

function commaOf(parts: Code[]): Code {
  return many(
    function* (i, e) {
      for (const c of parts) {
        if (c.one) {
          const v = c.one(i, e);
          if (v !== NONE) yield v;
        } else yield* c.all(i, e);
      }
    },
    () =>
      function* (input, path, env) {
        for (const c of parts) yield* c.paths(input, path, env);
      },
  );
}

function selectOf(cond: Code): Code {
  const co = cond.one;
  const paths = (): Paths =>
    function* (input, path, env) {
      for (const c of cond.all(input, env)) if (truthy(c)) yield { p: path, v: input };
    };
  if (co) {
    return single((i, e) => {
      const c = co(i, e);
      return c !== NONE && truthy(c) ? i : NONE;
    }, paths);
  }
  return many(function* (i, e) {
    for (const c of cond.all(i, e)) if (truthy(c)) yield i;
  }, paths);
}

function ifOf(cond: Code, then: Code, otherwise: Code): Code {
  const co = cond.one;
  const paths = (): Paths =>
    function* (input, path, env) {
      for (const c of cond.all(input, env)) {
        yield* (truthy(c) ? then : otherwise).paths(input, path, env);
      }
    };
  if (co && then.one && otherwise.one) {
    const t = then.one;
    const o = otherwise.one;
    return single((i, e) => {
      const c = co(i, e);
      return c === NONE ? NONE : truthy(c) ? t(i, e) : o(i, e);
    }, paths);
  }
  if (co) {
    return many((i, e) => {
      const c = co(i, e);
      return c === NONE ? EMPTY : (truthy(c) ? then : otherwise).all(i, e);
    }, paths);
  }
  return many(function* (i, e) {
    for (const c of cond.all(i, e)) yield* (truthy(c) ? then : otherwise).all(i, e);
  }, paths);
}

function tryOf(body: Code, handler: Code | null): Code {
  const bo = body.one;
  const paths = (): Paths =>
    function* (input, path, env) {
      let it: Iterator<PathValue>;
      try {
        it = body.paths(input, path, env)[Symbol.iterator]();
      } catch (x) {
        if (!(x instanceof Thrown)) throw x;
        if (handler) yield* handler.paths(x.value, null, env);
        return;
      }
      for (;;) {
        let r: IteratorResult<PathValue>;
        try {
          r = it.next();
        } catch (x) {
          if (!(x instanceof Thrown)) throw x;
          if (handler) yield* handler.paths(x.value, null, env);
          return;
        }
        if (r.done) return;
        yield r.value;
      }
    };
  if (bo && (!handler || handler.one)) {
    const ho = handler ? handler.one : null;
    return single((i, e) => {
      try {
        return bo(i, e);
      } catch (x) {
        if (!(x instanceof Thrown)) throw x;
        return ho ? ho(x.value, e) : NONE;
      }
    }, paths);
  }
  return many(function* (i, e) {
    let it: Iterator<unknown>;
    try {
      it = body.all(i, e)[Symbol.iterator]();
    } catch (x) {
      if (!(x instanceof Thrown)) throw x;
      if (handler) yield* handler.all(x.value, e);
      return;
    }
    for (;;) {
      let r: IteratorResult<unknown>;
      try {
        r = it.next();
      } catch (x) {
        if (!(x instanceof Thrown)) throw x;
        if (handler) yield* handler.all(x.value, e);
        return;
      }
      if (r.done) return;
      yield r.value;
    }
  }, paths);
}

/** `of[key]`: the key is evaluated on the input of the whole term, and loops outermost. */
function indexOf(of: Code, key: Code): Code {
  const oo = of.one;
  const ko = key.one;
  const paths = (): Paths =>
    function* (input, path, env) {
      for (const k of key.all(input, env)) {
        for (const pv of of.paths(input, path, env)) yield { p: extend(pv, k), v: index(pv.v, k) };
      }
    };
  if (oo && ko) {
    return single((i, e) => {
      const k = ko(i, e);
      if (k === NONE) return NONE;
      const v = oo(i, e);
      return v === NONE ? NONE : index(v, k);
    }, paths);
  }
  return many(function* (i, e) {
    for (const k of key.all(i, e)) for (const v of of.all(i, e)) yield index(v, k);
  }, paths);
}

/** `of.name`, the common case of `indexOf`. */
function fieldOf(of: Code, name: string): Code {
  const oo = of.one;
  const get = (v: unknown): unknown => (isObj(v) ? field(v, name) : index(v, name));
  const paths = (): Paths =>
    function* (input, path, env) {
      for (const pv of of.paths(input, path, env)) yield { p: extend(pv, name), v: get(pv.v) };
    };
  if (of === IDENTITY)
    return single(get, () => (input, path) => [
      { p: extend({ p: path, v: input }, name), v: get(input) },
    ]);
  if (oo) {
    return single((i, e) => {
      const v = oo(i, e);
      return v === NONE ? NONE : get(v);
    }, paths);
  }
  return many(function* (i, e) {
    for (const v of of.all(i, e)) yield get(v);
  }, paths);
}

function iterateOf(of: Code): Code {
  const oo = of.one;
  const paths = (): Paths =>
    function* (input, path, env) {
      for (const pv of of.paths(input, path, env)) {
        const v = pv.v;
        if (!Array.isArray(v) && !isObj(v)) iterate(v);
        if (!pv.p) fail(`Invalid path expression near attempt to iterate through ${dump(v)}`);
        const base = pv.p as Path;
        if (Array.isArray(v)) {
          tick(v.length);
          for (let i = 0; i < v.length; i++) yield { p: [...base, i], v: v[i] };
        } else {
          const o = v as Obj;
          const keys = Object.keys(o);
          tick(keys.length);
          for (const k of keys) yield { p: [...base, k], v: o[k] };
        }
      }
    };
  if (of === IDENTITY) return many(iterate, paths);
  if (oo) {
    return many((i, e) => {
      const v = oo(i, e);
      return v === NONE ? EMPTY : iterate(v);
    }, paths);
  }
  return many(function* (i, e) {
    for (const v of of.all(i, e)) yield* iterate(v);
  }, paths);
}

/** Runs `f` on every combination of the outputs of `args`: the last loops outermost unless `firstOuter`. */
function* combinations(
  args: Code[],
  input: unknown,
  env: Env,
  firstOuter: boolean,
): Generator<unknown[]> {
  const n = args.length;
  const vals: unknown[] = new Array(n);
  function* go(level: number): Generator<unknown[]> {
    if (level === n) {
      yield vals.slice();
      return;
    }
    const pos = firstOuter ? level : n - 1 - level;
    for (const v of args[pos].all(input, env)) {
      vals[pos] = v;
      yield* go(level + 1);
    }
  }
  yield* go(0);
}

// --- Scopes -----------------------------------------------------------------

interface Fn {
  name: string;
  params: Param[];
  body: Node;
  /** Frames in scope where it was defined. */
  depth: number;
  /** Its compiled body; null until then, and while compiling it (a recursive call). */
  code: Code | null;
  busy: boolean;
}

/** What a name means at one point of the program. Mirrors the frames at run time. */
interface Sc {
  kind: "var" | "filter" | "label" | "fn";
  name: string;
  /** Frames up to and including this one (a function adds none). */
  depth: number;
  up: Sc | null;
  fn?: Fn;
  /** A `$param`: also callable as a filter by its bare name. */
  callable?: boolean;
}

const depthOf = (sc: Sc | null): number => (sc ? sc.depth : 0);
const bindVar = (sc: Sc | null, name: string, callable = false): Sc => ({
  kind: "var",
  name,
  depth: depthOf(sc) + 1,
  up: sc,
  callable,
});

function hopsTo(sc: Sc | null, kind: Sc["kind"], name: string): number {
  for (let s = sc; s; s = s.up) {
    if (s.kind === kind && s.name === name) return depthOf(sc) - s.depth;
  }
  return -1;
}

// --- Patterns ---------------------------------------------------------------

interface Binder {
  /** The scope with the pattern's variables. */
  sc: Sc | null;
  /** The frames with them bound, when there is exactly one way to. */
  one: ((value: unknown, env: Env) => Env) | null;
  all: (value: unknown, env: Env) => Iterable<Env>;
}

function bindThen(prev: Binder, sub: Binder, get: (v: unknown) => unknown): Binder {
  const po = prev.one;
  const so = sub.one;
  if (po && so) {
    const one = (v: unknown, e: Env): Env => so(get(v), po(v, e));
    return { sc: sub.sc, one, all: (v, e) => [one(v, e)] };
  }
  return {
    sc: sub.sc,
    one: null,
    *all(v, e) {
      for (const e1 of prev.all(v, e)) yield* sub.all(get(v), e1);
    },
  };
}

function compPattern(pat: Pattern, sc: Sc | null): Binder {
  if (pat.t === "pvar") {
    const one = (v: unknown, e: Env): Env => ({ v, up: e });
    return { sc: bindVar(sc, pat.name), one, all: (v, e) => [one(v, e)] };
  }
  let out: Binder = { sc, one: (_v, e) => e, all: (_v, e) => [e] };
  if (pat.t === "parr") {
    pat.items.forEach((item, i) => {
      out = bindThen(out, compPattern(item, out.sc), (v) => index(v, i));
    });
    return out;
  }
  for (const entry of pat.entries) {
    if (entry.name !== null) {
      const name = entry.name;
      const get = (v: unknown): unknown => index(v, name);
      out = bindThen(out, compPattern({ t: "pvar", name }, out.sc), get);
      if (entry.value) out = bindThen(out, compPattern(entry.value, out.sc), get);
      continue;
    }
    const keyNode = entry.key as Node;
    const value = entry.value as Pattern;
    if (keyNode.t === "lit") {
      const k = keyNode.v;
      out = bindThen(out, compPattern(value, out.sc), (v) => index(v, k));
      continue;
    }
    // A computed key: evaluated on the value being taken apart, once per output.
    const prev = out;
    const key = comp(keyNode, prev.sc);
    const sub = compPattern(value, prev.sc);
    out = {
      sc: sub.sc,
      one: null,
      *all(v, e) {
        for (const e1 of prev.all(v, e)) {
          for (const k of key.all(v, e1)) yield* sub.all(index(v, k), e1);
        }
      },
    };
  }
  return out;
}

// --- The compiler -----------------------------------------------------------

type N<T extends Node["t"]> = Node & { t: T };

function comp(n: Node, sc: Sc | null): Code {
  switch (n.t) {
    case "id":
      return IDENTITY;
    case "rec":
      return builtin("recurse", [], n.pos);
    case "lit": {
      const v = n.v;
      return single(() => v);
    }
    case "loc": {
      const line = n.line;
      return single(() => ({ file: FILE, line }));
    }
    case "str":
      return compString(n, sc);
    case "fmt": {
      const f = formatter(n.name, n.pos);
      return single((i) => f(i));
    }
    case "idx": {
      const of = comp(n.of, sc);
      if (n.key.t === "lit" && typeof n.key.v === "string") return fieldOf(of, n.key.v);
      return indexOf(of, comp(n.key, sc));
    }
    case "slice":
      return compSlice(n, sc);
    case "iter":
      return iterateOf(comp(n.of, sc));
    case "arr": {
      if (!n.body) return single(() => []);
      const body = comp(n.body, sc);
      const bo = body.one;
      if (bo) {
        return single((i, e) => {
          const v = bo(i, e);
          return v === NONE ? [] : [v];
        });
      }
      return single((i, e) => {
        const out: unknown[] = [];
        for (const v of body.all(i, e)) out.push(v);
        return out;
      });
    }
    case "obj":
      return compObject(n, sc);
    case "neg": {
      const of = comp(n.of, sc);
      const oo = of.one;
      if (oo) {
        return single((i, e) => {
          const v = oo(i, e);
          return v === NONE ? NONE : negate(v);
        });
      }
      return many(function* (i, e) {
        for (const v of of.all(i, e)) yield negate(v);
      });
    }
    case "pipe":
      return pipeOf(comp(n.l, sc), comp(n.r, sc));
    case "comma": {
      const parts: Node[] = [];
      let cur: Node = n;
      while (cur.t === "comma") {
        parts.push(cur.r);
        cur = cur.l;
      }
      parts.push(cur);
      return commaOf(parts.reverse().map((p) => comp(p, sc)));
    }
    case "bin":
      return compBinary(n, sc);
    case "and":
    case "or":
      return compLogic(n, sc);
    case "alt":
      return compAlternative(n, sc);
    case "assign":
      return compAssign(n, sc);
    case "if":
      return ifOf(comp(n.cond, sc), comp(n.then, sc), n.else ? comp(n.else, sc) : IDENTITY);
    case "try":
      return tryOf(comp(n.body, sc), n.handler ? comp(n.handler, sc) : null);
    case "reduce":
      return compReduce(n, sc);
    case "foreach":
      return compForeach(n, sc);
    case "def": {
      const fn: Fn = {
        name: n.name,
        params: n.params,
        body: n.body,
        depth: depthOf(sc),
        code: null,
        busy: false,
      };
      const inner: Sc = { kind: "fn", name: n.name, depth: depthOf(sc), up: sc, fn };
      compileFn(fn, inner);
      return comp(n.rest, inner);
    }
    case "call":
      return compCall(n, sc);
    case "var":
      return compVar(n, sc);
    case "as":
      return compAs(n, sc);
    case "label":
      return compLabel(n, sc);
    case "break": {
      const hops = hopsTo(sc, "label", n.name);
      if (hops < 0) throw new JqError(`jq: $*label-${n.name} is not defined`, n.pos);
      return single((_i, e) => {
        throw new BreakSignal(at(e, hops) as object);
      });
    }
  }
}

function compVar(n: N<"var">, sc: Sc | null): Code {
  if (n.name === "ENV") return single(() => ({}));
  if (n.name === "__prog_args") throw unsupported("$__prog_args", n.pos);
  const hops = hopsTo(sc, "var", n.name);
  if (hops < 0) throw new JqError(`jq: $${n.name} is not defined`, n.pos);
  if (hops === 0) return single((_i, e) => (e as Frame).v);
  if (hops === 1) return single((_i, e) => ((e as Frame).up as Frame).v);
  return single((_i, e) => at(e, hops));
}

function compString(n: N<"str">, sc: Sc | null): Code {
  const text = n.fmt ? formatter(n.fmt, n.pos) : toText;
  const parts = n.parts.map((p) => (typeof p === "string" ? p : comp(p, sc)));
  const codes = parts.filter((p): p is Code => typeof p !== "string");
  const join = (vals: unknown[]): string => {
    let out = "";
    let k = 0;
    for (const p of parts) out += typeof p === "string" ? p : text(vals[k++]);
    checkLength(out.length);
    return out;
  };
  if (codes.every((c) => c.one)) {
    return single((i, e) => {
      const vals: unknown[] = [];
      for (const c of codes) {
        const v = (c.one as One)(i, e);
        if (v === NONE) return NONE;
        vals.push(v);
      }
      return join(vals);
    });
  }
  // The last interpolation loops outermost.
  return many(function* (i, e) {
    for (const vals of combinations(codes, i, e, false)) yield join(vals);
  });
}

function compSlice(n: N<"slice">, sc: Sc | null): Code {
  const of = comp(n.of, sc);
  const nothing = single(() => null);
  const bounds = [n.from ? comp(n.from, sc) : nothing, n.to ? comp(n.to, sc) : nothing];
  const key = (b: unknown[]): Obj => ({ start: b[0], end: b[1] });
  const paths = (): Paths =>
    function* (input, path, env) {
      for (const b of combinations(bounds, input, env, true)) {
        for (const pv of of.paths(input, path, env)) {
          const k = key(b);
          yield { p: extend(pv, k), v: sliceOf(pv.v, k) };
        }
      }
    };
  const [fo, to] = [bounds[0].one, bounds[1].one];
  const oo = of.one;
  if (fo && to && oo) {
    return single((i, e) => {
      const from = fo(i, e);
      if (from === NONE) return NONE;
      const end = to(i, e);
      if (end === NONE) return NONE;
      const v = oo(i, e);
      return v === NONE ? NONE : sliceOf(v, key([from, end]));
    }, paths);
  }
  return many(function* (i, e) {
    for (const b of combinations(bounds, i, e, true)) {
      for (const v of of.all(i, e)) yield sliceOf(v, key(b));
    }
  }, paths);
}

function compObject(n: N<"obj">, sc: Sc | null): Code {
  if (!n.entries.length) return single(() => ({}));
  const entries = n.entries.map((entry) => ({
    name: entry.key.t === "lit" && typeof entry.key.v === "string" ? entry.key.v : null,
    key: comp(entry.key, sc),
    value: comp(entry.value, sc),
  }));
  const build = (keys: unknown[], vals: unknown[]): Obj => {
    const o: Obj = {};
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j];
      if (typeof k !== "string") fail(`Object keys must be strings, not ${describe(k)}`);
      put(o, k as string, vals[j]);
    }
    return o;
  };
  if (entries.every((x) => x.name !== null && x.value.one)) {
    const names = entries.map((x) => x.name as string);
    const values = entries.map((x) => x.value.one as One);
    return single((i, e) => {
      const o: Obj = {};
      for (let j = 0; j < names.length; j++) {
        const v = values[j](i, e);
        if (v === NONE) return NONE;
        put(o, names[j], v);
      }
      return o;
    });
  }
  // The first entry loops outermost, and its key before its value.
  const flat = entries.flatMap((x) => [x.key, x.value]);
  return many(function* (i, e) {
    for (const vals of combinations(flat, i, e, true)) {
      yield build(
        vals.filter((_, j) => j % 2 === 0),
        vals.filter((_, j) => j % 2 === 1),
      );
    }
  });
}

function compBinary(n: N<"bin">, sc: Sc | null): Code {
  const f = BINARY[n.op];
  const l = comp(n.l, sc);
  const r = comp(n.r, sc);
  const lo = l.one;
  const ro = r.one;
  if (lo && n.r.t === "lit") {
    const b = n.r.v;
    return single((i, e) => {
      const a = lo(i, e);
      return a === NONE ? NONE : f(a, b);
    });
  }
  if (lo && ro) {
    return single((i, e) => {
      const b = ro(i, e);
      if (b === NONE) return NONE;
      const a = lo(i, e);
      return a === NONE ? NONE : f(a, b);
    });
  }
  // The right operand loops outermost.
  return many(function* (i, e) {
    for (const b of r.all(i, e)) for (const a of l.all(i, e)) yield f(a, b);
  });
}

function compLogic(n: N<"and" | "or">, sc: Sc | null): Code {
  const l = comp(n.l, sc);
  const r = comp(n.r, sc);
  const lo = l.one;
  const ro = r.one;
  // What the left side decides on its own: false for `and`, true for `or`.
  const short = n.t === "or";
  if (lo && ro) {
    return single((i, e) => {
      const a = lo(i, e);
      if (a === NONE) return NONE;
      if (truthy(a) === short) return short;
      const b = ro(i, e);
      return b === NONE ? NONE : truthy(b);
    });
  }
  return many(function* (i, e) {
    for (const a of l.all(i, e)) {
      if (truthy(a) === short) yield short;
      else for (const b of r.all(i, e)) yield truthy(b);
    }
  });
}

function compAlternative(n: N<"alt">, sc: Sc | null): Code {
  const l = comp(n.l, sc);
  const r = comp(n.r, sc);
  const lo = l.one;
  const ro = r.one;
  const paths = (): Paths =>
    function* (input, path, env) {
      let found = false;
      for (const pv of l.paths(input, path, env)) {
        if (!truthy(pv.v)) continue;
        found = true;
        yield pv;
      }
      if (!found) yield* r.paths(input, path, env);
    };
  if (lo && ro) {
    return single((i, e) => {
      const a = lo(i, e);
      return a !== NONE && truthy(a) ? a : ro(i, e);
    }, paths);
  }
  return many(function* (i, e) {
    let found = false;
    for (const a of l.all(i, e)) {
      if (!truthy(a)) continue;
      found = true;
      yield a;
    }
    if (!found) yield* r.all(i, e);
  }, paths);
}

function compAs(n: N<"as">, sc: Sc | null): Code {
  const src = comp(n.src, sc);
  const binder = compPattern(n.pat, sc);
  const body = comp(n.body, binder.sc);
  const so = src.one;
  const bind = binder.one;
  const paths = (): Paths =>
    function* (input, path, env) {
      for (const v of src.all(input, env)) {
        for (const e of binder.all(v, env)) yield* body.paths(input, path, e);
      }
    };
  if (bind && so && body.one) {
    const bo = body.one;
    return single((i, e) => {
      const v = so(i, e);
      return v === NONE ? NONE : bo(i, bind(v, e));
    }, paths);
  }
  if (bind && so) {
    return many((i, e) => {
      const v = so(i, e);
      return v === NONE ? EMPTY : body.all(i, bind(v, e));
    }, paths);
  }
  return many(function* (i, e) {
    for (const v of src.all(i, e)) {
      for (const e1 of binder.all(v, e)) yield* body.all(i, e1);
    }
  }, paths);
}

function compLabel(n: N<"label">, sc: Sc | null): Code {
  const inner: Sc = { kind: "label", name: n.name, depth: depthOf(sc) + 1, up: sc };
  const body = comp(n.body, inner);
  const bo = body.one;
  const paths = (): Paths =>
    function* (input, path, env) {
      const label = {};
      try {
        yield* body.paths(input, path, { v: label, up: env });
      } catch (x) {
        if (!(x instanceof BreakSignal) || x.label !== label) throw x;
      }
    };
  if (bo) {
    return single((i, e) => {
      const label = {};
      try {
        return bo(i, { v: label, up: e });
      } catch (x) {
        if (!(x instanceof BreakSignal) || x.label !== label) throw x;
        return NONE;
      }
    }, paths);
  }
  return many(function* (i, e) {
    const label = {};
    try {
      yield* body.all(i, { v: label, up: e });
    } catch (x) {
      if (!(x instanceof BreakSignal) || x.label !== label) throw x;
    }
  }, paths);
}

/** The frames of a pattern's variables for each output of `src`. */
function* bindings(src: Code, binder: Binder, input: unknown, env: Env): Generator<Env> {
  const bind = binder.one;
  for (const v of src.all(input, env)) {
    if (bind) yield bind(v, env);
    else yield* binder.all(v, env);
  }
}

function compReduce(n: N<"reduce">, sc: Sc | null): Code {
  const src = comp(n.src, sc);
  const init = comp(n.init, sc);
  const binder = compPattern(n.pat, sc);
  const update = comp(n.update, binder.sc);
  const uo = update.one;
  const mutate = inPlace(n.update, binder.sc);
  const run = (input: unknown, env: Env, start: unknown): unknown => {
    let acc = start;
    const own = mutate ? newOwner() : null;
    for (const e of bindings(src, binder, input, env)) {
      // An update without output leaves null, as jq 1.7 does.
      if (mutate) {
        const next = mutate(acc, e, own as Owner);
        acc = next === NONE ? null : next;
      } else if (uo) {
        const next = uo(acc, e);
        acc = next === NONE ? null : next;
      } else {
        let last: unknown = null;
        for (const v of update.all(acc, e)) last = v;
        acc = last;
      }
    }
    return acc;
  };
  const paths = (): Paths =>
    function* (input, path, env) {
      for (const start of init.paths(input, path, env)) {
        let acc = start;
        for (const e of bindings(src, binder, input, env)) {
          let last: PathValue = { p: null, v: null };
          for (const pv of update.paths(acc.v, acc.p, e)) last = pv;
          acc = last;
        }
        yield acc;
      }
    };
  const io = init.one;
  if (io) {
    return single((i, e) => {
      const start = io(i, e);
      return start === NONE ? NONE : run(i, e, start);
    }, paths);
  }
  return many(function* (i, e) {
    for (const start of init.all(i, e)) yield run(i, e, start);
  }, paths);
}

function compForeach(n: N<"foreach">, sc: Sc | null): Code {
  const src = comp(n.src, sc);
  const init = comp(n.init, sc);
  const binder = compPattern(n.pat, sc);
  const update = comp(n.update, binder.sc);
  const extract = n.extract ? comp(n.extract, binder.sc) : null;
  return many(
    function* (i, e) {
      for (const start of init.all(i, e)) {
        let state = start;
        for (const e1 of bindings(src, binder, i, e)) {
          const loaded = state;
          state = null;
          for (const v of update.all(loaded, e1)) {
            state = v;
            if (extract) yield* extract.all(v, e1);
            else yield v;
          }
        }
      }
    },
    () =>
      function* (input, path, env) {
        for (const start of init.paths(input, path, env)) {
          let state = start;
          for (const e1 of bindings(src, binder, input, env)) {
            const loaded = state;
            state = { p: null, v: null };
            for (const pv of update.paths(loaded.v, loaded.p, e1)) {
              state = pv;
              if (extract) yield* extract.paths(pv.v, pv.p, e1);
              else yield pv;
            }
          }
        }
      },
  );
}

// --- Assignment -------------------------------------------------------------

/** `paths |= update`: the first output replaces the value; a path without output is deleted at the end. */
function modify(
  root: unknown,
  paths: Iterable<PathValue>,
  update: (old: unknown) => unknown,
): unknown {
  const own = newOwner();
  let cur = root;
  let gone: Path[] | null = null;
  for (const pv of paths) {
    const p = pv.p;
    if (!p) return notPath(pv.v);
    tick(1);
    const old = getPath(cur, p);
    const next = update(old);
    if (next === NONE) {
      if (!gone) gone = [];
      gone.push(p);
      continue;
    }
    cur = setPath(cur, p, 0, next, own);
    // What `update` gave may share parts with what was there: stop trusting them.
    if (next !== old && isContainer(next)) keepOnly(own, cur, p);
  }
  return gone ? deletePaths(cur, gone) : cur;
}

function compAssign(n: N<"assign">, sc: Sc | null): Code {
  const l = comp(n.l, sc);
  const r = comp(n.r, sc);
  if (n.op === "=") {
    const assign = (input: unknown, env: Env, value: unknown): unknown => {
      const own = newOwner();
      let cur = input;
      for (const pv of l.paths(input, [], env)) {
        if (!pv.p) return notPath(pv.v);
        tick(1);
        cur = setPath(cur, pv.p, 0, value, own);
      }
      return cur;
    };
    const ro = r.one;
    if (ro) {
      return single((i, e) => {
        const v = ro(i, e);
        return v === NONE ? NONE : assign(i, e, v);
      });
    }
    return many(function* (i, e) {
      for (const v of r.all(i, e)) yield assign(i, e, v);
    });
  }
  if (n.op === "|=") {
    return single((i, e) => modify(i, l.paths(i, [], e), (old) => firstOf(r, old, e)));
  }
  // `a op= b` is `b as $x | a |= (. op $x)`.
  const op = n.op.slice(0, -1);
  const f: Binary = op === "//" ? (a, b) => (truthy(a) ? a : b) : BINARY[op];
  const ro = r.one;
  if (ro) {
    return single((i, e) => {
      const x = ro(i, e);
      return x === NONE ? NONE : modify(i, l.paths(i, [], e), (old) => f(old, x));
    });
  }
  return many(function* (i, e) {
    for (const x of r.all(i, e)) yield modify(i, l.paths(i, [], e), (old) => f(old, x));
  });
}

// --- Function calls ---------------------------------------------------------

function compileFn(fn: Fn, sc: Sc | null): void {
  let inner = sc;
  for (const p of fn.params) {
    inner = p.isVar
      ? bindVar(inner, p.name, true)
      : { kind: "filter", name: p.name, depth: depthOf(inner) + 1, up: inner };
  }
  fn.busy = true;
  fn.code = comp(fn.body, inner);
  fn.busy = false;
}

function compCall(n: N<"call">, sc: Sc | null): Code {
  const arity = n.args.length;
  const depth = depthOf(sc);
  for (let s = sc; s; s = s.up) {
    if (s.name !== n.name) continue;
    if (s.kind === "fn" && s.fn && s.fn.params.length === arity) {
      return callFn(
        s.fn,
        n.args.map((a) => comp(a, sc)),
        depth - s.fn.depth,
      );
    }
    if (arity === 0 && s.kind === "filter") {
      const hops = depth - s.depth;
      return many(
        (i, e) => {
          const c = at(e, hops) as Closure;
          return c.code.all(i, c.env);
        },
        () => (input, path, e) => {
          const c = at(e, hops) as Closure;
          return c.code.paths(input, path, c.env);
        },
      );
    }
    if (arity === 0 && s.kind === "var" && s.callable) {
      const hops = depth - s.depth;
      return single((_i, e) => at(e, hops));
    }
  }
  return builtin(
    n.name,
    n.args.map((a) => comp(a, sc)),
    n.pos,
  );
}

/** A call of a function written in jq, `hops` frames below where it was defined. */
function callFn(fn: Fn, args: Code[], hops: number): Code {
  const params = fn.params;
  const valued = params.some((p) => p.isVar);
  const base = (e: Env): Env => {
    let b = e;
    for (let i = hops; i > 0; i--) b = (b as Frame).up;
    return b;
  };
  /** The frames for the body, when no `$param` needs evaluating. */
  const enter = (e: Env): Env => {
    let f = fn.depth === 0 ? null : base(e);
    for (const code of args) f = { v: { code, env: e }, up: f };
    return f;
  };
  /** One set of frames per combination of the `$param` values, the first looping outermost. */
  function* enterAll(input: unknown, e: Env): Generator<Env> {
    const start = fn.depth === 0 ? null : base(e);
    function* go(k: number, f: Env): Generator<Env> {
      if (k === args.length) yield f;
      else if (!params[k].isVar) yield* go(k + 1, { v: { code: args[k], env: e }, up: f });
      else for (const v of args[k].all(input, e)) yield* go(k + 1, { v, up: f });
    }
    yield* go(0, start);
  }
  const body = (): Code => fn.code as Code;
  const paths = (): Paths =>
    function* (input, path, e) {
      tick(1);
      if (!valued) yield* body().paths(input, path, enter(e));
      else for (const f of enterAll(input, e)) yield* body().paths(input, path, f);
    };
  if (valued) {
    return many(function* (i, e) {
      for (const f of enterAll(i, e)) {
        tick(1);
        yield* body().all(i, f);
      }
    }, paths);
  }
  const one = fn.code?.one;
  if (one) {
    return single((i, e) => {
      tick(1);
      return one(i, enter(e));
    }, paths);
  }
  return many((i, e) => {
    tick(1);
    return body().all(i, enter(e));
  }, paths);
}

// ---------------------------------------------------------------------------
// Regular expressions. jq uses Oniguruma (Perl syntax, UTF-8); here a pattern
// is rewritten for JavaScript's RegExp with the `u` flag, so that `.`, `^`,
// `$`, `\w`, `\d`, `\b`, POSIX brackets, `\A \z \Z \Q..\E \x{..}` and
// `\p{Script}` behave as they do in jq. Real differences that remain:
// - Flags inside a pattern (`(?i)`, `(?s)`, `(?m)`, `(?x)`) are read only at its start.
// - No atomic groups, possessive quantifiers, `\G`, `\K`, `\X`, subexpression
//   calls, absent operators or `&&` in a character class: they are errors.
// - `[\W]` and `[\D]` inside a character class stay ASCII-only.
// - Flag `l` (longest match) has no effect, and `n` only drops empty matches
//   (jq looks for a non-empty match at the same place instead).
// - jq steps over an empty match by one byte and so can report a position
//   inside a multi-byte character; here every match starts on a code point.
// - A pattern can still take exponential time to match: that is not budgeted.

interface Regex {
  source: string;
  flags: string;
  /** The name of each capture group, in order. */
  names: (string | null)[];
  plain: RegExp | null;
  indexed: RegExp | null;
}

interface RegexFlags {
  global: boolean;
  noEmpty: boolean;
  ignoreCase: boolean;
  extended: boolean;
  dotAll: boolean;
}

const WORD = "\\p{L}\\p{M}\\p{Nd}\\p{Pc}";
const BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
const NOT_BOUNDARY = `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;
const REGEX_SYNTAX = "^$\\.*+?()[]{}|/";
/** POSIX bracket names: [inside a class with `u`, without `u`, the single property to negate]. */
const POSIX: Record<string, [string, string, string | null]> = {
  alpha: ["\\p{Alphabetic}", "A-Za-z", "Alphabetic"],
  digit: ["\\p{Nd}", "0-9", "Nd"],
  alnum: ["\\p{Alphabetic}\\p{Nd}", "A-Za-z0-9", null],
  upper: ["\\p{Uppercase}", "A-Z", "Uppercase"],
  lower: ["\\p{Lowercase}", "a-z", "Lowercase"],
  space: ["\\s", "\\s", null],
  blank: [" \\t", " \\t", null],
  punct: ["\\p{P}$+<=>^`|~", "!-\\/:-@\\[-`{-~", null],
  cntrl: ["\\p{Cc}", "\\x00-\\x1f\\x7f", "Cc"],
  xdigit: ["0-9A-Fa-f", "0-9A-Fa-f", null],
  word: [WORD, "\\w", null],
  ascii: ["\\x00-\\x7f", "\\x00-\\x7f", null],
};
const PROPERTY_ALIASES: Record<string, string> = {
  alpha: "Alphabetic",
  digit: "Nd",
  upper: "Uppercase",
  lower: "Lowercase",
  space: "White_Space",
  punct: "P",
  cntrl: "Cc",
};

const regexCache = new Map<string, Regex>();
const propertyCache = new Map<string, string | null>();

function compiles(source: string, flags: string): boolean {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

/** The JavaScript name of an Oniguruma property such as `Han` or `alpha`. */
function propertyName(name: string): string | null {
  const cached = propertyCache.get(name);
  if (cached !== undefined) return cached;
  const lower = name.toLowerCase().replace(/[ _-]/g, "");
  const title = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  const tries = [PROPERTY_ALIASES[lower], name, title, `Script=${name}`, `Script=${title}`];
  const found = tries.find((t) => t && /^[\w=]+$/.test(t) && compiles(`\\p{${t}}`, "u")) ?? null;
  if (propertyCache.size > 500) propertyCache.clear();
  propertyCache.set(name, found);
  return found;
}

function hex(code: number, unicode: boolean): string {
  if (code > 0x10ffff) return fail("a character code in the regex is too large");
  if (code <= 0xff) return `\\x${code.toString(16).padStart(2, "0")}`;
  if (code <= 0xffff) return `\\u${code.toString(16).padStart(4, "0")}`;
  if (unicode) return `\\u{${code.toString(16)}}`;
  const c = code - 0x10000;
  return `\\u${(0xd800 + (c >> 10)).toString(16)}\\u${(0xdc00 + (c & 0x3ff)).toString(16)}`;
}

/** Rewrites an Oniguruma pattern as a JavaScript one. */
function translateRegex(pattern: string, flags: RegexFlags, unicode: boolean): Regex {
  let p = pattern;
  let { ignoreCase, extended, dotAll } = flags;
  let multiline = false;
  for (;;) {
    const m = /^\(\?([imsx]*)(?:-([imsx]*))?\)/.exec(p);
    if (!m || !(m[1] + (m[2] ?? ""))) break;
    for (const [letters, on] of [
      [m[1], true],
      [m[2] ?? "", false],
    ] as [string, boolean][]) {
      if (letters.includes("i")) ignoreCase = on;
      if (letters.includes("x")) extended = on;
      if (letters.includes("s")) dotAll = on;
      if (letters.includes("m")) multiline = on;
    }
    p = p.slice(m[0].length);
  }
  const names: (string | null)[] = [];
  const n = p.length;
  let out = "";
  let i = 0;
  let quantified: boolean = false;
  const bad = (what: string): never =>
    fail(`${pattern} (at offset ${i}) is not a valid regex: ${what}`);
  const word = unicode ? WORD : "\\w";

  const property = (inClass: boolean): void => {
    // At `\p{` or `\P{`.
    const close = p.indexOf("}", i);
    if (p[i + 2] !== "{" || close < 0) bad("invalid property name");
    let name = p.slice(i + 3, close);
    let negated = p[i + 1] === "P";
    if (name.startsWith("^")) {
      negated = !negated;
      name = name.slice(1);
    }
    if (!unicode) bad("\\p{...} needs a pattern JavaScript accepts in Unicode mode");
    const lower = name.toLowerCase();
    const js = propertyName(name);
    if (js) out += `\\${negated ? "P" : "p"}{${js}}`;
    else if (Object.hasOwn(POSIX, lower) && !(negated && inClass)) {
      out += inClass ? POSIX[lower][0] : `[${negated ? "^" : ""}${POSIX[lower][0]}]`;
    } else bad(`unknown property name {${name}}`);
    i = close + 1;
  };

  /** One `\...` at `i`, outside or inside a character class. */
  const escape = (inClass: boolean): void => {
    const d = p[i + 1];
    if (d === undefined) return bad("end pattern at escape");
    i += 2;
    switch (d) {
      case "d":
        out += unicode ? "\\p{Nd}" : "\\d";
        return;
      case "D":
        out += unicode && !inClass ? "\\P{Nd}" : "\\D";
        return;
      case "w":
        out += inClass ? word : `[${word}]`;
        return;
      case "W":
        out += inClass ? "\\W" : `[^${word}]`;
        return;
      case "s":
      case "S":
      case "n":
      case "r":
      case "t":
      case "f":
      case "v":
        out += `\\${d}`;
        return;
      case "b":
        out += inClass ? "\\x08" : unicode ? BOUNDARY : "\\b";
        return;
      case "B":
        out += inClass ? "B" : unicode ? NOT_BOUNDARY : "\\B";
        return;
      case "A":
        out += inClass ? "A" : "(?<![\\s\\S])";
        return;
      case "z":
        out += inClass ? "z" : "(?![\\s\\S])";
        return;
      case "Z":
        out += inClass ? "Z" : "(?=\\n?(?![\\s\\S]))";
        return;
      case "R":
        if (inClass) return bad("\\R in a character class");
        out += "(?:\\r\\n|[\\n\\v\\f\\r\\x85\\u2028\\u2029])";
        return;
      case "a":
        out += "\\x07";
        return;
      case "e":
        out += "\\x1b";
        return;
      case "G":
      case "K":
      case "X":
      case "g":
      case "y":
      case "Y":
        return bad(`\\${d} is not supported`);
      case "0": {
        const m = /^[0-7]{0,2}/.exec(p.slice(i, i + 2));
        const digits = m ? m[0] : "";
        i += digits.length;
        out += hex(Number.parseInt(digits || "0", 8), unicode);
        return;
      }
      case "x": {
        const m = /^(?:\{([0-9a-fA-F]{1,8})\}|([0-9a-fA-F]{1,2}))/.exec(p.slice(i, i + 10));
        if (!m) return bad("invalid \\x escape");
        i += m[0].length;
        out += hex(Number.parseInt(m[1] ?? m[2], 16), unicode);
        return;
      }
      case "u": {
        const m = /^[0-9a-fA-F]{4}/.exec(p.slice(i, i + 4));
        if (!m) return bad("invalid \\u escape");
        i += 4;
        out += `\\u${m[0]}`;
        return;
      }
      case "c": {
        const m = /^[A-Za-z]/.exec(p.slice(i, i + 1));
        if (!m) return bad("invalid control escape");
        i += 1;
        out += hex(m[0].toUpperCase().charCodeAt(0) ^ 0x40, unicode);
        return;
      }
      case "k": {
        const m = /^(?:<(\w+)>|'(\w+)')/.exec(p.slice(i));
        const at = m ? names.indexOf(m[1] ?? m[2]) : -1;
        if (!m || at < 0 || inClass) return bad("undefined name reference");
        i += m[0].length;
        out += `(?:\\${at + 1})`;
        return;
      }
      case "p":
      case "P":
        i -= 2;
        property(inClass);
        return;
      case "Q": {
        let end = p.indexOf("\\E", i);
        if (end < 0) end = n;
        for (const ch of p.slice(i, end)) out += /[\w\s]/.test(ch) ? ch : `\\${ch}`;
        i = Math.min(n, end + 2);
        return;
      }
      case "E":
        return;
    }
    if (d >= "1" && d <= "9") {
      const m = /^\d*/.exec(p.slice(i));
      const digits = d + (m ? m[0] : "");
      i += digits.length - 1;
      if (inClass || Number(digits) > names.length) return bad("invalid backref number");
      out += `(?:\\${digits})`;
      return;
    }
    // A letter Oniguruma gives no meaning is itself; so is escaped punctuation.
    if (/[A-Za-z0-9_\s]/.test(d)) out += d;
    else if (REGEX_SYNTAX.includes(d) || d === "-") out += inClass || d !== "-" ? `\\${d}` : d;
    else {
      // Keep a surrogate pair whole.
      const cp = p.codePointAt(i - 1) ?? 0;
      if (cp > 0xffff) i++;
      out += String.fromCodePoint(cp);
    }
  };

  const charClass = (): void => {
    out += "[";
    i++;
    if (p[i] === "^") {
      out += "^";
      i++;
    }
    if (p[i] === "]") {
      out += "\\]";
      i++;
    }
    for (;;) {
      if (i >= n) return bad("premature end of char-class");
      const c = p[i];
      if (c === "]") break;
      if (c === "\\") {
        escape(true);
      } else if (c === "[") {
        const m = /^\[:(\^?)([a-z]+):\]/.exec(p.slice(i, i + 16));
        if (m && Object.hasOwn(POSIX, m[2])) {
          const [uni, ascii, single] = POSIX[m[2]];
          if (!m[1]) out += unicode ? uni : ascii;
          else if (unicode && single) out += `\\P{${single}}`;
          else return bad(`[:^${m[2]}:] is not supported`);
          i += m[0].length;
        } else if (m) {
          return bad(`[:${m[2]}:] is not supported`);
        } else {
          out += "\\[";
          i++;
        }
      } else if (c === "&" && p[i + 1] === "&") {
        return bad("&& in a character class is not supported");
      } else {
        out += c;
        i++;
      }
    }
    out += "]";
    i++;
  };

  const group = (): void => {
    if (p[i + 1] !== "?") {
      names.push(null);
      out += "(";
      i++;
      return;
    }
    const rest = p.slice(i, i + 80);
    const named = /^\(\?(?:P?<([A-Za-z_]\w*)>|'([A-Za-z_]\w*)')/.exec(rest);
    const plain = /^\(\?(?::|=|!|<=|<!)/.exec(rest);
    if (named) {
      names.push(named[1] ?? named[2]);
      out += "(";
      i += named[0].length;
    } else if (plain) {
      out += plain[0];
      i += plain[0].length;
    } else if (rest.startsWith("(?#")) {
      const close = p.indexOf(")", i);
      if (close < 0) return bad("end pattern in group");
      i = close + 1;
    } else if (rest.startsWith("(?>")) {
      return bad("atomic groups are not supported");
    } else if (/^\(\?[imsx-]+[:)]/.test(rest)) {
      return bad("flags inside a pattern are only read at its start");
    } else {
      return bad("undefined group option");
    }
  };

  while (i < n) {
    const c = p[i];
    const wasQuantified: boolean = quantified;
    quantified = false;
    switch (c) {
      case "\\":
        escape(false);
        break;
      case "[":
        charClass();
        break;
      case "(":
        group();
        break;
      case ".":
        out += dotAll ? "[\\s\\S]" : "[^\\n]";
        i++;
        break;
      case "^":
        out += multiline ? "(?<![^\\n])" : "^";
        i++;
        break;
      case "$":
        out += multiline ? "(?![^\\n])" : "(?=\\n?$)";
        i++;
        break;
      case "*":
      case "+":
      case "?":
        if (wasQuantified && c === "+") return bad("possessive quantifiers are not supported");
        quantified = !wasQuantified;
        out += c;
        i++;
        break;
      case "{": {
        const m = /^\{\d+(?:,\d*)?\}/.exec(p.slice(i, i + 24));
        if (m) {
          out += m[0];
          i += m[0].length;
          quantified = true;
        } else {
          out += "\\{";
          i++;
        }
        break;
      }
      case "}":
      case "]":
        out += `\\${c}`;
        i++;
        break;
      default:
        if (extended && /\s/.test(c)) {
          i++;
        } else if (extended && c === "#") {
          const end = p.indexOf("\n", i);
          i = end < 0 ? n : end + 1;
        } else {
          out += c;
          i++;
        }
    }
  }
  const jsFlags = `g${unicode ? "u" : ""}${ignoreCase ? "i" : ""}`;
  return { source: out, flags: jsFlags, names, plain: null, indexed: null };
}

function parseRegexFlags(flags: unknown): RegexFlags {
  const out = { global: false, noEmpty: false, ignoreCase: false, extended: false, dotAll: false };
  if (flags == null) return out;
  if (typeof flags !== "string") return fail(`${describe(flags)} is not a string`);
  for (const c of flags) {
    if (c === "g") out.global = true;
    else if (c === "i") out.ignoreCase = true;
    else if (c === "x") out.extended = true;
    else if (c === "n") out.noEmpty = true;
    else if (c === "p") out.dotAll = true;
    // `s` (single line) is how patterns are read anyway; `l` (longest) is not available.
    else if (c !== "s" && c !== "l") return fail(`${flags} is not a valid modifier string`);
  }
  return out;
}

function regexFor(pattern: unknown, flags: RegexFlags): Regex {
  if (typeof pattern !== "string") {
    return fail(`${describe(pattern)} cannot be matched, as it is not a string`);
  }
  const key = `${flags.ignoreCase ? "i" : ""}${flags.extended ? "x" : ""}${flags.dotAll ? "p" : ""}/${pattern}`;
  const cached = regexCache.get(key);
  if (cached) return cached;
  let rx = translateRegex(pattern, flags, true);
  if (!compiles(rx.source, rx.flags)) {
    // Without `u` JavaScript is more lenient; matching is then by UTF-16 unit.
    let loose: Regex | null = null;
    try {
      loose = translateRegex(pattern, flags, false);
    } catch (x) {
      if (!(x instanceof Thrown)) throw x;
    }
    if (!loose || !compiles(loose.source, loose.flags)) {
      let why = "invalid pattern";
      try {
        new RegExp(rx.source, rx.flags);
      } catch (x) {
        if (x instanceof Error) why = x.message.replace(/^Invalid regular expression: /, "");
      }
      return fail(`${pattern} (at offset 0) is not a valid regex: ${why}`);
    }
    rx = loose;
  }
  if (regexCache.size >= 256) regexCache.clear();
  regexCache.set(key, rx);
  return rx;
}

/** The matches of `rx` in `s`, one after another; `re.lastIndex` is set anew for each. */
function* execAll(
  s: unknown,
  rx: Regex,
  flags: RegexFlags,
  indices: boolean,
): Generator<RegExpExecArray> {
  if (typeof s !== "string") return fail(`${describe(s)} cannot be matched, as it is not a string`);
  let re: RegExp;
  if (indices) {
    if (!rx.indexed) rx.indexed = new RegExp(rx.source, `${rx.flags}d`);
    re = rx.indexed;
  } else {
    if (!rx.plain) rx.plain = new RegExp(rx.source, rx.flags);
    re = rx.plain;
  }
  tick(1 + (s.length >> 6));
  let pos = 0;
  while (pos <= s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return;
    tick(1);
    const end = m.index + m[0].length;
    if (m[0].length) {
      pos = end;
    } else {
      // Step over one code point so the same empty match is not found again.
      pos = end + ((s.codePointAt(end) ?? 0) > 0xffff ? 2 : 1);
      if (flags.noEmpty) continue;
    }
    yield m;
    if (!flags.global) return;
  }
}

/** Turns UTF-16 offsets into code point offsets, cheaply when asked in rising order. */
function offsetCounter(s: string): (unit: number) => number {
  if (!SURROGATES.test(s)) return (unit) => unit;
  let lastUnit = 0;
  let lastCp = 0;
  return (unit) => {
    if (unit < lastUnit) return codePointsBetween(s, 0, unit);
    lastCp += codePointsBetween(s, lastUnit, unit);
    lastUnit = unit;
    return lastCp;
  };
}

function matchObject(
  s: string,
  m: RegExpExecArray,
  rx: Regex,
  count: (unit: number) => number,
): Obj {
  const offset = count(m.index);
  const captures: Obj[] = [];
  const spans = m.indices;
  for (let k = 1; k < m.length; k++) {
    const name = rx.names[k - 1] ?? null;
    const text = m[k];
    const span = spans ? spans[k] : undefined;
    if (text === undefined || !span) {
      captures.push({ offset: -1, length: 0, string: null, name });
    } else {
      const from =
        span[0] >= m.index ? offset + codePointsBetween(s, m.index, span[0]) : count(span[0]);
      captures.push({ offset: from, length: codePointLength(text), string: text, name });
    }
  }
  return { offset, length: codePointLength(m[0]), string: m[0], captures };
}

function* matchAll(s: unknown, pattern: unknown, flags: unknown): Generator<Obj> {
  const f = parseRegexFlags(flags);
  const rx = regexFor(pattern, f);
  let count: ((unit: number) => number) | null = null;
  for (const m of execAll(s, rx, f, true)) {
    if (!count) count = offsetCounter(s as string);
    yield matchObject(s as string, m, rx, count);
  }
}

function testRegex(s: unknown, pattern: unknown, flags: unknown): boolean {
  const f = parseRegexFlags(flags);
  const rx = regexFor(pattern, f);
  for (const _m of execAll(s, rx, { ...f, global: false }, false)) return true;
  return false;
}

/** The named groups of a match: a later group of the same name wins, as in jq. */
function captureObject(m: RegExpExecArray, rx: Regex): Obj {
  const out: Obj = {};
  for (let k = 1; k < m.length; k++) {
    const name = rx.names[k - 1];
    if (name != null) put(out, name, m[k] === undefined ? null : m[k]);
  }
  return out;
}

/** `[re, flags]` or `re`, as the one-argument forms take it. */
function regexArgs(v: unknown): [unknown, unknown] {
  if (typeof v === "string") return [v, null];
  if (Array.isArray(v) && v.length > 1) return [v[0], v[1]];
  if (Array.isArray(v) && v.length > 0) return [v[0], null];
  return fail(`${kind(v)} not a string or array`);
}

function* scan(s: unknown, pattern: unknown, flags: unknown): Generator<unknown> {
  const f = parseRegexFlags(add("g", flags));
  const rx = regexFor(pattern, f);
  for (const m of execAll(s, rx, f, false)) {
    if (m.length > 1) yield m.slice(1).map((x) => (x === undefined ? null : x));
    else yield m[0];
  }
}

function* splits(s: unknown, pattern: unknown, flags: unknown): Generator<unknown> {
  const f = parseRegexFlags(add("g", flags));
  const rx = regexFor(pattern, f);
  let from = 0;
  for (const m of execAll(s, rx, f, false)) {
    yield (s as string).slice(from, m.index);
    from = m.index + m[0].length;
  }
  yield (s as string).slice(from);
}

/** jq's `sub`: every output of `replacement` gives one result. */
function* substitute(
  s: unknown,
  pattern: unknown,
  flags: unknown,
  replacement: Code,
  env: Env,
): Generator<unknown> {
  const f = parseRegexFlags(flags);
  const rx = regexFor(pattern, f);
  const results: unknown[] = [];
  let from = 0;
  for (const m of execAll(s, rx, f, false)) {
    const gap = (s as string).slice(from, m.index);
    let k = 0;
    for (const insert of replacement.all(captureObject(m, rx), env)) {
      results[k] = add(k < results.length ? results[k] : null, add(gap, insert));
      k++;
    }
    from = m.index + m[0].length;
  }
  if (!results.length) {
    yield s;
    return;
  }
  const rest = (s as string).slice(from);
  for (const r of results) yield add(r, rest);
}

// ---------------------------------------------------------------------------
// Formats (@name)

const HTML: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&apos;",
  '"': "&quot;",
};

function checked(s: string): string {
  checkLength(s.length);
  tick(s.length >> 4);
  return s;
}

function csvRow(v: unknown, tsv: boolean): string {
  if (!Array.isArray(v)) {
    return fail(`${describe(v)} cannot be ${tsv ? "tsv" : "csv"}-formatted, only an array can be`);
  }
  tick(v.length);
  const cells = v.map((x) => {
    switch (kind(x)) {
      case "null":
        return "";
      case "boolean":
        return x ? "true" : "false";
      case "number":
        return numberText(x as number);
      case "string":
        if (!tsv) return `"${(x as string).replaceAll('"', '""')}"`;
        return (x as string).replace(/[\\\t\n\r]/g, (c) =>
          c === "\\" ? "\\\\" : c === "\t" ? "\\t" : c === "\n" ? "\\n" : "\\r",
        );
      default:
        return fail(`${describe(x)} is not valid in a ${tsv ? "tsv" : "csv"} row`);
    }
  });
  return checked(cells.join(tsv ? "\t" : ","));
}

function shellQuote(v: unknown): string {
  const one = (x: unknown): string => {
    if (typeof x === "string") return `'${x.replaceAll("'", "'\\''")}'`;
    if (isContainer(x)) return fail(`${describe(x)} can not be escaped for shell`);
    return toJson(x);
  };
  return checked(Array.isArray(v) ? v.map(one).join(" ") : one(v));
}

function base64Decode(v: unknown): string {
  const text = toText(v);
  const cut = text.indexOf("=");
  const data = cut < 0 ? text : text.slice(0, cut);
  if (!/^[A-Za-z0-9+/]*$/.test(data) || data.length % 4 === 1) {
    return fail(`${describe(v)} is not valid base64 data`);
  }
  tick(data.length >> 4);
  return Buffer.from(data, "base64").toString("utf8");
}

function formatter(name: string, pos: number): (v: unknown) => string {
  switch (name) {
    case "text":
      return toText;
    case "json":
      return toJson;
    case "csv":
      return (v) => csvRow(v, false);
    case "tsv":
      return (v) => csvRow(v, true);
    case "html":
      return (v) => checked(toText(v).replace(/[&<>'"]/g, (c) => HTML[c]));
    case "uri":
      return (v) =>
        checked(
          encodeURIComponent(toText(v).replace(LONE_SURROGATES, "�")).replace(
            /[!'()*]/g,
            (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
        );
    case "sh":
      return shellQuote;
    case "base64":
      return (v) => {
        const text = toText(v);
        checkLength(Math.ceil(text.length / 3) * 4);
        return Buffer.from(text, "utf8").toString("base64");
      };
    case "base64d":
      return base64Decode;
    case "base32":
    case "base32d":
      throw unsupported(`@${name}`, pos);
    default:
      throw new JqError(`jq: ${name} is not a valid format`, pos);
  }
}

// ---------------------------------------------------------------------------
// Dates (UTC only)

interface BrokenTime {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  weekday: number;
  yearday: number;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY_MS = 86_400_000;

/** Seconds since the epoch for broken-down UTC time; fields out of range carry over. */
function timegm(t: BrokenTime): number {
  const d = new Date(0);
  d.setUTCFullYear(t.year, t.month, t.day);
  d.setUTCHours(t.hours, t.minutes, Math.trunc(t.seconds), 0);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return fail("invalid gmtime representation");
  return ms / 1000;
}

function gmtime(v: unknown): BrokenTime {
  if (typeof v !== "number") return fail("gmtime() requires a number");
  const d = new Date(Math.trunc(v) * 1000);
  if (Number.isNaN(d.getTime())) {
    return fail("error converting number of seconds since epoch to datetime");
  }
  const year = d.getUTCFullYear();
  const start = new Date(0);
  start.setUTCFullYear(year, 0, 1);
  return {
    year,
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds() + (v - Math.floor(v)),
    weekday: d.getUTCDay(),
    yearday: Math.floor((d.getTime() - start.getTime()) / DAY_MS),
  };
}

/** jq's "broken down time" array: year, month (0-11), day, hours, minutes, seconds, weekday, day of year. */
function brokenTime(v: unknown, who: string): BrokenTime {
  if (!Array.isArray(v)) return fail(`${who} requires array inputs`);
  if (v.length < 8 || v.slice(0, 8).some((x) => typeof x !== "number")) {
    return fail(`${who} requires parsed datetime inputs`);
  }
  const [year, month, day, hours, minutes, seconds, weekday, yearday] = (v as number[]).map((x) =>
    Math.trunc(x),
  );
  return { year, month, day, hours, minutes, seconds, weekday, yearday };
}

function mktime(v: unknown): number {
  const secs = timegm(brokenTime(v, "mktime"));
  // timegm() answers -1 for "cannot represent", and jq takes it at its word.
  if (secs === -1) return fail("invalid gmtime representation");
  return secs;
}

const isLeap = (y: number): boolean => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

/** ISO 8601 week number and its year, the way glibc works them out. */
function isoWeek(t: BrokenTime): [number, number] {
  const days = (yearday: number): number => yearday - ((yearday - t.weekday + 4 + 378) % 7) + 3;
  let year = t.year;
  let d = days(t.yearday);
  if (d < 0) {
    year--;
    d = days(t.yearday + 365 + (isLeap(year) ? 1 : 0));
  } else {
    const next = days(t.yearday - 365 - (isLeap(year) ? 1 : 0));
    if (next >= 0) {
      year++;
      d = next;
    }
  }
  return [year, Math.floor(d / 7) + 1];
}

function strftime(t: BrokenTime, format: string): string {
  const num = (n: number, width: number, fill: string, flag: string): string => {
    const digits = String(Math.abs(n));
    const sign = n < 0 ? "-" : "";
    if (flag === "-") return sign + digits;
    return sign + digits.padStart(width, flag === "_" ? " " : flag === "0" ? "0" : fill);
  };
  const hour12 = t.hours % 12 === 0 ? 12 : t.hours % 12;
  const one = (d: string, flag: string): string | null => {
    switch (d) {
      case "a":
        return (WEEKDAYS[t.weekday] ?? "?").slice(0, 3);
      case "A":
        return WEEKDAYS[t.weekday] ?? "?";
      case "b":
      case "h":
        return (MONTHS[t.month] ?? "?").slice(0, 3);
      case "B":
        return MONTHS[t.month] ?? "?";
      case "c":
        return `${one("a", "")} ${one("b", "")} ${one("e", "")} ${one("T", "")} ${one("Y", "")}`;
      case "C":
        return num(Math.floor(t.year / 100), 2, "0", flag);
      case "d":
        return num(t.day, 2, "0", flag);
      case "D":
      case "x":
        return `${one("m", "")}/${one("d", "")}/${one("y", "")}`;
      case "e":
        return num(t.day, 2, " ", flag);
      case "F":
        return `${one("Y", "")}-${one("m", "")}-${one("d", "")}`;
      case "g":
        return num(((isoWeek(t)[0] % 100) + 100) % 100, 2, "0", flag);
      case "G":
        return num(isoWeek(t)[0], 1, "0", flag);
      case "H":
        return num(t.hours, 2, "0", flag);
      case "I":
        return num(hour12, 2, "0", flag);
      case "j":
        return num(t.yearday + 1, 3, "0", flag);
      case "k":
        return num(t.hours, 2, " ", flag);
      case "l":
        return num(hour12, 2, " ", flag);
      case "m":
        return num(t.month + 1, 2, "0", flag);
      case "M":
        return num(t.minutes, 2, "0", flag);
      case "n":
        return "\n";
      case "p":
        return t.hours < 12 ? "AM" : "PM";
      case "P":
        return t.hours < 12 ? "am" : "pm";
      case "r":
        return `${one("I", "")}:${one("M", "")}:${one("S", "")} ${one("p", "")}`;
      case "R":
        return `${one("H", "")}:${one("M", "")}`;
      case "s":
        return String(timegm(t));
      case "S":
        return num(Math.trunc(t.seconds), 2, "0", flag);
      case "t":
        return "\t";
      case "T":
      case "X":
        return `${one("H", "")}:${one("M", "")}:${one("S", "")}`;
      case "u":
        return String(t.weekday === 0 ? 7 : t.weekday);
      case "U":
        return num(Math.floor((t.yearday + 7 - t.weekday) / 7), 2, "0", flag);
      case "V":
        return num(isoWeek(t)[1], 2, "0", flag);
      case "w":
        return String(t.weekday);
      case "W":
        return num(Math.floor((t.yearday + 7 - ((t.weekday + 6) % 7)) / 7), 2, "0", flag);
      case "y":
        return num(((t.year % 100) + 100) % 100, 2, "0", flag);
      case "Y":
        return num(t.year, 1, "0", flag);
      case "z":
        return "+0000";
      case "Z":
        return "UTC";
      case "%":
        return "%";
      default:
        return null;
    }
  };
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c !== "%" || i + 1 >= format.length) {
      out += c;
      continue;
    }
    let j = i + 1;
    let flag = "";
    if ("-_0^".includes(format[j]) && j + 1 < format.length) flag = format[j++];
    while ((format[j] === "E" || format[j] === "O") && j + 1 < format.length) j++;
    const piece = one(format[j], flag);
    if (piece === null) out += format.slice(i, j + 1);
    else out += flag === "^" ? piece.toUpperCase() : piece;
    i = j;
  }
  return checked(out);
}

function formatTime(v: unknown, format: unknown): string {
  const t = typeof v === "number" ? gmtime(v) : brokenTime(v, "strftime/1");
  if (typeof format !== "string") return fail("strftime/1 requires a string format");
  return strftime(t, format);
}

const ISO_FORMAT = "%Y-%m-%dT%H:%M:%SZ";

/** `strptime("%Y-%m-%dT%H:%M:%SZ") | mktime`, the one format jq's date helpers read. */
function parseIsoDate(v: unknown): number {
  if (typeof v !== "string") return fail("strptime/1 requires string inputs and arguments");
  const m = /^\s*(\d{1,4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{1,2}):(\d{1,2})Z$/.exec(v);
  const f = m ? m.slice(1).map(Number) : [];
  if (!m || f[1] < 1 || f[1] > 12 || f[2] < 1 || f[2] > 31 || f[3] > 23 || f[4] > 59 || f[5] > 61) {
    return fail(`date ${JSON.stringify(v)} does not match format ${JSON.stringify(ISO_FORMAT)}`);
  }
  const secs = timegm({
    year: f[0],
    month: f[1] - 1,
    day: f[2],
    hours: f[3],
    minutes: f[4],
    seconds: f[5],
    weekday: 0,
    yearday: 0,
  });
  if (secs === -1) return fail("invalid gmtime representation");
  return secs;
}

// ---------------------------------------------------------------------------
// Text and numbers

/** A number from text as jq's tonumber reads it, or null. */
function parseNumber(text: string): number | null {
  const s = text.trim();
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return Number(s);
  if (/^[+-]?nan$/i.test(s)) return Number.NaN;
  if (/^[+-]?inf(?:inity)?$/i.test(s)) {
    return s.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  return null;
}

const CONTROL_CHARS = /[\u0000-\u001f]/g;

/** JSON as jq reads it: also `nan`, `Infinity`, `01`, `.5` and raw control characters in strings. */
function parseLooseJson(s: string): unknown {
  let i = 0;
  const bad = (what: string): never =>
    fail(`${what} (while parsing '${s.length > 80 ? `${s.slice(0, 80)}...` : s}')`);
  const space = (): void => {
    while (i < s.length && " \t\n\r".includes(s[i])) i++;
  };
  const text = (): string => {
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
    if (j >= s.length) return bad("Unfinished string");
    const raw = s.slice(i, j + 1).replace(CONTROL_CHARS, (c) => {
      return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
    });
    i = j + 1;
    try {
      return JSON.parse(raw) as string;
    } catch {
      return bad("Invalid escape");
    }
  };
  const value = (depth: number): unknown => {
    if (depth > 10_000) return bad("Exceeds depth limit for parsing");
    tick(1);
    space();
    const c = s[i];
    if (c === '"') return text();
    if (c === "[") {
      const out: unknown[] = [];
      i++;
      space();
      if (s[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1));
        space();
        if (s[i] === "]") break;
        if (s[i] !== ",") return bad("Expected separator between values");
        i++;
      }
      i++;
      return out;
    }
    if (c === "{") {
      const out: Obj = {};
      i++;
      space();
      if (s[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        space();
        if (s[i] !== '"') return bad("Object keys must be strings");
        const k = text();
        space();
        if (s[i] !== ":") return bad("Objects must consist of key:value pairs");
        i++;
        put(out, k, value(depth + 1));
        space();
        if (s[i] === "}") break;
        if (s[i] !== ",") return bad("Expected separator between values");
        i++;
      }
      i++;
      return out;
    }
    let j = i;
    while (j < s.length && !' \t\n\r,:[]{}"'.includes(s[j])) j++;
    const word = s.slice(i, j);
    if (!word) return bad("Expected JSON value");
    i = j;
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    const num = parseNumber(word);
    return num === null ? bad("Invalid literal") : num;
  };
  const out = value(0);
  space();
  if (i < s.length) return bad("Unexpected extra JSON values");
  return out;
}

function fromJson(v: unknown): unknown {
  if (typeof v !== "string") return fail(`${describe(v)} cannot be parsed as JSON`);
  tick(1 + (v.length >> 4));
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return parseLooseJson(v);
  }
}

function toNumber(v: unknown): unknown {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseNumber(v);
    if (n !== null) return n;
  }
  return fail(`${describe(v)} cannot be parsed as a number`);
}

function explode(v: unknown): unknown {
  if (typeof v !== "string") return fail("explode input must be a string");
  tick(v.length);
  const out: number[] = [];
  for (const ch of v) out.push(ch.codePointAt(0) as number);
  return out;
}

function implode(v: unknown): unknown {
  if (!Array.isArray(v)) return fail("implode input must be an array");
  checkLength(v.length);
  const parts: string[] = [];
  for (const x of v) {
    if (typeof x !== "number") {
      return fail(`${describe(x)} can't be imploded, unicode codepoint needs to be numeric`);
    }
    const cp = Math.trunc(x);
    const valid = cp >= 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff);
    parts.push(valid ? String.fromCodePoint(cp) : "�");
  }
  return parts.join("");
}

function changeCase(v: unknown, upper: boolean): unknown {
  if (typeof v !== "string") return fail("explode input must be a string");
  tick(v.length >> 4);
  return upper
    ? v.replace(/[a-z]+/g, (m) => m.toUpperCase())
    : v.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

function trim(v: unknown, left: boolean, right: boolean): unknown {
  if (typeof v !== "string") return fail("trim input must be a string");
  let from = 0;
  let to = v.length;
  const blank = (c: string): boolean => c === " " || (c >= "\t" && c <= "\r");
  if (left) while (from < to && blank(v[from])) from++;
  if (right) while (to > from && blank(v[to - 1])) to--;
  return v.slice(from, to);
}

/** Where `sub` starts in `s`, in UTF-8 bytes as jq counts them, overlaps included. */
function stringIndices(s: string, sub: string): number[] {
  const out: number[] = [];
  if (!sub) return out;
  tick(1 + (s.length >> 6));
  let bytes = 0;
  let from = 0;
  for (let at = s.indexOf(sub); at >= 0; at = s.indexOf(sub, at + 1)) {
    tick(1);
    bytes += utf8Length(s.slice(from, at));
    from = at;
    out.push(bytes);
  }
  return out;
}

function indices(v: unknown, i: unknown): unknown {
  if (Array.isArray(v)) return arrayIndices(v, Array.isArray(i) ? i : [i]);
  if (typeof v === "string" && typeof i === "string") return stringIndices(v, i);
  return index(v, i);
}

function joinStrings(v: unknown, sep: unknown): unknown {
  // reduce .[] as $i (null; (if . == null then "" else . + $sep end) + piece) // ""
  const pieces = iterate(v).map((item) =>
    typeof item === "number" || typeof item === "boolean" ? toJson(item) : truthy(item) ? item : "",
  );
  if (typeof sep === "string" && pieces.every((x) => typeof x === "string")) {
    return checked(pieces.join(sep));
  }
  let acc: unknown = null;
  for (const piece of pieces) acc = add(acc === null ? "" : add(acc, sep), piece);
  return truthy(acc) ? acc : "";
}

function flatten(v: unknown, depth: number): unknown[] {
  const out: unknown[] = [];
  for (const item of iterate(v)) {
    if (Array.isArray(item) && depth !== 0) for (const x of flatten(item, depth - 1)) out.push(x);
    else out.push(item);
  }
  return out;
}

function addAll(v: unknown): unknown {
  const items = iterate(v);
  let acc: unknown = null;
  let fresh = false;
  for (const x of items) {
    if (Array.isArray(acc) && Array.isArray(x)) {
      // One growing copy instead of one copy per element.
      if (!fresh) acc = acc.slice();
      fresh = true;
      tick(x.length);
      for (const y of x) (acc as unknown[]).push(y);
    } else if (isObj(acc) && isObj(x)) {
      if (!fresh) acc = { ...acc };
      fresh = true;
      const keys = Object.keys(x);
      tick(keys.length);
      for (const k of keys) put(acc as Obj, k, x[k]);
    } else {
      acc = add(acc, x);
      fresh = false;
    }
  }
  return acc;
}

function toEntries(v: unknown): unknown {
  return keysOf(v, false).map((k) => ({ key: k, value: index(v, k) }));
}

function fromEntries(v: unknown): unknown {
  const out: Obj = {};
  for (const e of iterate(v)) {
    let key: unknown = null;
    for (const name of ["key", "Key", "name", "Name"]) {
      key = index(e, name);
      if (truthy(key)) break;
    }
    if (typeof key !== "string") return fail(`Cannot use ${describe(key)} as object key`);
    put(out, key, has(e, "value") ? index(e, "value") : index(e, "Value"));
  }
  return out;
}

function reverse(v: unknown): unknown {
  if (Array.isArray(v)) {
    tick(v.length);
    return v.slice().reverse();
  }
  // jq's definition: [.[length - 1 - range(0; length)]], which only an array survives.
  if ((lengthOf(v) as number) > 0) index(v, 0);
  return [];
}

// --- Sorting ----------------------------------------------------------------

function sortValues(v: unknown): unknown[] {
  if (!Array.isArray(v)) return fail(`${describe(v)} cannot be sorted, as it is not an array`);
  tick(v.length);
  let numbers = true;
  let strings = true;
  for (const x of v) {
    if (typeof x !== "number" || Number.isNaN(x) || Object.is(x, -0)) numbers = false;
    if (typeof x !== "string" || HIGH_CHARS.test(x)) strings = false;
    if (!numbers && !strings) break;
  }
  if (numbers) return Array.from(Float64Array.from(v as number[]).sort());
  if (strings) return (v as string[]).slice().sort();
  return v.slice().sort(compare);
}

/** A key is one value (or NONE) when the key filter gives at most one, else the array of its outputs. */
function sortKeys(
  f: Code,
  v: unknown,
  env: Env,
  what: string,
): { values: unknown[]; keys: unknown[] } {
  const items = iterate(v);
  const fo = f.one;
  const keys = items.map((x) => (fo ? fo(x, env) : Array.from(f.all(x, env))));
  if (!Array.isArray(v)) return fail(`${describe(v)} cannot be ${what}, as it is not an array`);
  return { values: v, keys };
}

function compareKeys(a: unknown, b: unknown): number {
  if (a === NONE || b === NONE) return a === b ? 0 : a === NONE ? -1 : 1;
  return compare(a, b);
}

/** The positions of `keys` in sorted order, equal keys in their first order. */
function sortedOrder(keys: unknown[]): number[] {
  const order = keys.map((_, i) => i);
  return order.sort((a, b) => compareKeys(keys[a], keys[b]) || a - b);
}

function groupBy(values: unknown[], keys: unknown[]): unknown[][] {
  const groups: unknown[][] = [];
  let last: unknown = NONE;
  let open = false;
  for (const i of sortedOrder(keys)) {
    if (open && compareKeys(keys[i], last) === 0) groups[groups.length - 1].push(values[i]);
    else groups.push([values[i]]);
    last = keys[i];
    open = true;
  }
  return groups;
}

function extreme(values: unknown[], keys: unknown[], max: boolean): unknown {
  if (!values.length) return null;
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    // The first of equal minimums, the last of equal maximums.
    if (compareKeys(keys[i], keys[best]) < 0 !== max) best = i;
  }
  return values[best];
}

function bsearch(v: unknown, target: unknown): unknown {
  if (!Array.isArray(v)) return fail(`${describe(v)} cannot be searched from`);
  let lo = 0;
  let hi = v.length - 1;
  while (lo <= hi) {
    tick(1);
    const mid = Math.floor((lo + hi) / 2);
    const c = compare(v[mid], target);
    if (c === 0) return mid;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1 - lo;
}

// --- Math -------------------------------------------------------------------

function roundEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** `x` as m * 2^e with 1 <= |m| < 2. */
function mantissa(x: number): [number, number] {
  let scaled = x;
  let e = 0;
  if (Math.abs(x) < 2 ** -1000) {
    scaled = x * 2 ** 100;
    e = -100;
  }
  const exp = Math.floor(Math.log2(Math.abs(scaled)));
  let m = scaled / 2 ** exp;
  e += exp;
  if (Math.abs(m) >= 2) {
    m /= 2;
    e++;
  } else if (Math.abs(m) < 1) {
    m *= 2;
    e--;
  }
  return [m, e];
}

const regular = (x: number): boolean => x !== 0 && Number.isFinite(x);

const MATH1: Record<string, (x: number) => unknown> = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: (x) => (x < 0 ? -Math.round(-x) : Math.round(x)),
  trunc: Math.trunc,
  rint: roundEven,
  nearbyint: roundEven,
  fabs: Math.abs,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  exp: Math.exp,
  exp2: (x) => 2 ** x,
  exp10: (x) => 10 ** x,
  expm1: Math.expm1,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  log1p: Math.log1p,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  significand: (x) => (regular(x) ? mantissa(x)[0] : x),
  logb: (x) => (regular(x) ? mantissa(x)[1] : x === 0 ? Number.NEGATIVE_INFINITY : Math.abs(x)),
  frexp: (x) => (regular(x) ? [mantissa(x)[0] / 2, mantissa(x)[1] + 1] : [x, 0]),
  modf: (x) =>
    Number.isFinite(x) ? [x - Math.trunc(x) || (x < 0 ? -0 : 0), Math.trunc(x)] : [0, x],
};

const MATH2: Record<string, (x: number, y: number) => number> = {
  pow: (x, y) => x ** y,
  atan2: Math.atan2,
  fmin: (x, y) => (Number.isNaN(x) ? y : Number.isNaN(y) ? x : Math.min(x, y)),
  fmax: (x, y) => (Number.isNaN(x) ? y : Number.isNaN(y) ? x : Math.max(x, y)),
  fmod: (x, y) => x % y,
  hypot: Math.hypot,
  ldexp: (x, y) => x * 2 ** Math.trunc(y),
  scalb: (x, y) => x * 2 ** y,
  scalbln: (x, y) => x * 2 ** Math.trunc(y),
  copysign: (x, y) => (y < 0 || Object.is(y, -0) ? -Math.abs(x) : Math.abs(x)),
  drem: (x, y) => x - y * roundEven(x / y),
  fdim: (x, y) => (x > y ? x - y : 0),
};

function numeric(v: unknown): number {
  if (typeof v !== "number") return fail(`${describe(v)} number required`);
  return v;
}

// ---------------------------------------------------------------------------
// Builtins

type Make = (args: Code[], pos: number) => Code;
type Native = (input: unknown, ...args: unknown[]) => unknown;

const BUILTINS = new Map<string, Make>();

function special(name: string, arity: number, make: Make): void {
  BUILTINS.set(`${name}/${arity}`, make);
}

/**
 * A builtin over values: called with every combination of its arguments'
 * outputs. In jq the last argument of a C function loops outermost and the
 * first `$param` of a jq-defined one does (`firstOuter`).
 */
function native(name: string, arity: number, f: Native, firstOuter = false): void {
  special(name, arity, (args) => {
    if (!arity) return single((i) => f(i));
    if (args.every((a) => a.one)) {
      const ones = args.map((a) => a.one as One);
      const first = ones[0];
      if (arity === 1) {
        return single((i, e) => {
          const x = first(i, e);
          return x === NONE ? NONE : f(i, x);
        });
      }
      return single((i, e) => {
        const vals: unknown[] = [];
        for (const one of ones) {
          const x = one(i, e);
          if (x === NONE) return NONE;
          vals.push(x);
        }
        return f(i, ...vals);
      });
    }
    return many(function* (i, e) {
      for (const vals of combinations(args, i, e, firstOuter)) yield f(i, ...vals);
    });
  });
}

/** Like `native`, for a builtin with any number of outputs. */
function stream(
  name: string,
  arity: number,
  f: (input: unknown, ...args: unknown[]) => Iterable<unknown>,
  firstOuter = false,
): void {
  special(name, arity, (args) =>
    many(function* (i, e) {
      if (!arity) yield* f(i);
      else for (const vals of combinations(args, i, e, firstOuter)) yield* f(i, ...vals);
    }),
  );
}

/** Names jq 1.7 has that this subset leaves out. */
const UNSUPPORTED = new Set([
  "input",
  "inputs",
  "input_filename",
  "input_line_number",
  "halt",
  "halt_error",
  "modulemeta",
  "get_search_list",
  "get_jq_origin",
  "get_prog_origin",
  "builtins",
  "localtime",
  "strflocaltime",
  "strptime",
  "gamma",
  "lgamma",
  "lgamma_r",
  "tgamma",
  "j0",
  "j1",
  "jn",
  "y0",
  "y1",
  "yn",
  "erf",
  "erfc",
  "nextafter",
  "nexttoward",
  "pow10",
]);

/**
 * Builtins written in jq, after jq's src/builtin.jq
 * (MIT license, Copyright (C) 2012 Stephen Dolan). `leaf_paths`, `date` and
 * `ascii` are from older releases.
 */
const PRELUDE = `
def values: select(. != null);
def nulls: select(. == null);
def booleans: select(type == "boolean");
def numbers: select(type == "number");
def strings: select(type == "string");
def arrays: select(type == "array");
def objects: select(type == "object");
def iterables: select(type|. == "array" or . == "object");
def scalars: select(type|. != "array" and . != "object");
def isfinite: type == "number" and (isinfinite | not);
def finites: select(isfinite);
def normals: select(isnormal);
def abs: if . < 0 then - . else . end;
def map_values(f): .[] |= f;
def del(f): delpaths([path(f)]);
def with_entries(f): to_entries | map(f) | from_entries;
def paths: path(recurse)|select(length > 0);
def paths(node_filter): path(recurse|select(node_filter))|select(length > 0);
def leaf_paths: paths(scalars);
def first: .[0];
def last: .[-1];
def nth($n): .[$n];
def in(xs): . as $x | xs | has($x);
def inside(xs): . as $x | xs | contains($x);
def index($i): indices($i) | .[0];
def rindex($i): indices($i) | .[-1:][0];
def combinations:
  if length == 0 then [] else .[0][] as $x | (.[1:] | combinations) as $y | [$x] + $y end;
def combinations(n): . as $dot | [range(n) | $dot] | combinations;
def transpose: [range(0; map(length)|max // 0) as $i | [.[][$i]]];
def walk(f):
  def w: if type == "object" then map_values(w) elif type == "array" then map(w) else . end | f;
  w;
def pick(pathexps): . as $in | reduce path(pathexps) as $a (null; setpath($a; $in|getpath($a)));
def debug(msgs): (msgs | debug | empty), .;
def todateiso8601: strftime("%Y-%m-%dT%H:%M:%SZ");
def todate: todateiso8601;
def fromdate: fromdateiso8601;
def date: todate;
def ascii:
  if type == "number" and . >= 0 and . <= 127 then [.] | implode
  else error("ascii only takes integers from 0 to 127") end;
def INDEX(stream; idx_expr): reduce stream as $row ({}; .[$row|idx_expr|tostring] = $row);
def INDEX(idx_expr): INDEX(.[]; idx_expr);
def JOIN($idx; idx_expr): [.[] | [., $idx[idx_expr]]];
def JOIN($idx; stream; idx_expr): stream | [., $idx[idx_expr]];
def JOIN($idx; stream; idx_expr; join_expr): stream | [., $idx[idx_expr]] | join_expr;
def IN(s): any(s == .; .);
def IN(src; s): any(src == s; .);
def truncate_stream(stream):
  . as $n | null | stream | . as $input
  | if (.[0]|length) > $n then setpath([0];$input[0][$n:]) else empty end;
def fromstream(i): {x: null, e: false} as $init
  | foreach i as $i ($init;
      if .e then $init else . end
      | if $i|length == 2
        then setpath(["e"]; $i[0]|length==0) | setpath(["x"]+$i[0]; $i[1])
        else setpath(["e"]; $i[0]|length==1) end;
      if .e then .x else empty end);
def tostream:
  path(def r: (.[]?|r), .; r) as $p | getpath($p) | reduce path(.[]?) as $q ([$p, .]; [$p+$q]);
`;

let preludeFns: Map<string, Fn> | null = null;

function prelude(): Map<string, Fn> {
  if (preludeFns) return preludeFns;
  const fns = new Map<string, Fn>();
  for (const d of new Parser(PRELUDE, lex(PRELUDE, 0, 0).toks).defs()) {
    fns.set(`${d.name}/${d.params.length}`, {
      name: d.name,
      params: d.params,
      body: d.body,
      depth: 0,
      code: null,
      busy: false,
    });
  }
  preludeFns = fns;
  return fns;
}

function builtin(name: string, args: Code[], pos: number): Code {
  const key = `${name}/${args.length}`;
  const make = BUILTINS.get(key);
  if (make) return make(args, pos);
  const fn = prelude().get(key);
  if (fn) {
    if (!fn.code && !fn.busy) compileFn(fn, null);
    return callFn(fn, args, 0);
  }
  if (UNSUPPORTED.has(name)) throw unsupported(name, pos);
  throw new JqError(`jq: ${key} is not defined`, pos);
}

// --- Control ---------------------------------------------------------------

special("empty", 0, () => single(() => NONE));
special("error", 0, () =>
  single((i) => {
    throw new Thrown(i);
  }),
);
special("error", 1, ([message]) =>
  pipeOf(
    message,
    single((i) => {
      throw new Thrown(i);
    }),
  ),
);
special("select", 1, ([cond]) => selectOf(cond));
special("debug", 0, () => IDENTITY);
special("stderr", 0, () => IDENTITY);
special("map", 1, ([f]) => {
  const fo = f.one;
  if (fo) {
    return single((i, e) => {
      const out: unknown[] = [];
      for (const x of iterate(i)) {
        const v = fo(x, e);
        if (v !== NONE) out.push(v);
      }
      return out;
    });
  }
  return single((i, e) => {
    const out: unknown[] = [];
    for (const x of iterate(i)) for (const v of f.all(x, e)) out.push(v);
    return out;
  });
});

special("path", 1, ([f]) =>
  many(function* (i, e) {
    for (const pv of f.paths(i, [], e)) {
      if (!pv.p) notPath(pv.v);
      yield pv.p;
    }
  }),
);

special("getpath", 1, ([p]) => {
  const get = (v: unknown, path: unknown): unknown => {
    if (!Array.isArray(path)) return fail("Path must be specified as an array");
    return getPath(v, path);
  };
  const po = p.one;
  const paths = (): Paths =>
    function* (input, path, env) {
      for (const q of p.all(input, env)) {
        const v = get(input, q);
        yield { p: path ? [...path, ...(q as Path)] : null, v };
      }
    };
  if (po) {
    return single((i, e) => {
      const q = po(i, e);
      return q === NONE ? NONE : get(i, q);
    }, paths);
  }
  return many(function* (i, e) {
    for (const q of p.all(i, e)) yield get(i, q);
  }, paths);
});

native("setpath", 2, (v, p, x) => {
  if (!Array.isArray(p)) return fail("Path must be specified as an array");
  return setPath(v, p, 0, x, null);
});
native("delpaths", 1, deletePaths);

/** `recurse`: the value and everything inside it, parents first. */
function* descend(v: unknown): Generator<unknown> {
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    tick(1);
    yield x === undefined ? null : x;
    if (Array.isArray(x)) {
      for (let i = x.length - 1; i >= 0; i--) stack.push(x[i]);
    } else if (isObj(x)) {
      const values = Object.values(x);
      for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
    }
  }
}

function* descendPaths(input: unknown, path: Path | null): Generator<PathValue> {
  const stack: PathValue[] = [{ p: path, v: input }];
  while (stack.length) {
    const pv = stack.pop() as PathValue;
    tick(1);
    yield pv;
    const { p, v } = pv;
    if (!p) continue;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ p: [...p, i], v: v[i] });
    } else if (isObj(v)) {
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) stack.push({ p: [...p, keys[i]], v: v[keys[i]] });
    }
  }
}

/** `def r: ., (f | r); r`, without recursion. */
function recurseWith(f: Code): Code {
  const fo = f.one;
  return many(
    function* (i, e) {
      if (fo) {
        for (let v = i; v !== NONE; v = fo(v, e)) {
          tick(1);
          yield v;
        }
        return;
      }
      yield i;
      const stack = [f.all(i, e)[Symbol.iterator]()];
      while (stack.length) {
        tick(1);
        const r = stack[stack.length - 1].next();
        if (r.done) stack.pop();
        else {
          yield r.value;
          stack.push(f.all(r.value, e)[Symbol.iterator]());
        }
      }
    },
    () =>
      function* (input, path, env) {
        yield { p: path, v: input };
        const stack = [f.paths(input, path, env)[Symbol.iterator]()];
        while (stack.length) {
          tick(1);
          const r = stack[stack.length - 1].next();
          if (r.done) stack.pop();
          else {
            yield r.value;
            stack.push(f.paths(r.value.v, r.value.p, env)[Symbol.iterator]());
          }
        }
      },
  );
}

special("recurse", 0, () => many(descend, () => descendPaths));
special("recurse", 1, ([f]) => recurseWith(f));
special("recurse", 2, ([f, cond]) => recurseWith(pipeOf(f, selectOf(cond))));

function* range(from: unknown, upto: unknown): Generator<unknown> {
  if (typeof from !== "number" || typeof upto !== "number") {
    return fail("Range bounds must be numeric");
  }
  for (let x = from; x < upto; x++) {
    tick(1);
    yield x;
  }
}

/** range/3 as jq defines it: `$init | while(. < $upto; . + $by)`, or downwards. */
function* rangeBy(init: unknown, upto: unknown, by: unknown): Generator<unknown> {
  const up = compare(by, 0);
  if (!up) return;
  for (let x = init; up > 0 ? compare(x, upto) < 0 : compare(x, upto) > 0; x = add(x, by)) {
    tick(1);
    yield x;
  }
}

stream("range", 1, (_v, n) => range(0, n));
stream("range", 2, (_v, from, upto) => range(from, upto), true);
stream("range", 3, (_v, init, upto, by) => rangeBy(init, upto, by), true);

special("limit", 2, ([n, f]) => {
  // foreach f as $item ($n; . - 1; $item, if . <= 0 then break else empty end)
  function* take<T>(count: unknown, items: () => Iterable<T>): Generator<T> {
    const sign = compare(count, 0);
    if (sign <= 0) {
      if (sign < 0) yield* items();
      return;
    }
    let left = count;
    for (const item of items()) {
      left = subtract(left, 1);
      yield item;
      if (compare(left, 0) <= 0) return;
    }
  }
  return many(
    function* (i, e) {
      for (const count of n.all(i, e)) yield* take(count, () => f.all(i, e));
    },
    () =>
      function* (input, path, env) {
        for (const count of n.all(input, env)) yield* take(count, () => f.paths(input, path, env));
      },
  );
});

special("first", 1, ([f]) =>
  single(
    (i, e) => firstOf(f, i, e),
    () =>
      function* (input, path, env) {
        for (const pv of f.paths(input, path, env)) {
          yield pv;
          return;
        }
      },
  ),
);
special("last", 1, ([f]) =>
  single((i, e) => {
    let last: unknown = null;
    for (const v of f.all(i, e)) last = v;
    return last;
  }),
);
special("nth", 2, ([n, f]) =>
  many(function* (i, e) {
    for (const count of n.all(i, e)) {
      if (compare(count, 0) < 0) fail("nth doesn't support negative indices");
      let left = add(count, 1);
      for (const v of f.all(i, e)) {
        left = subtract(left, 1);
        if (compare(left, 0) <= 0) {
          yield v;
          break;
        }
      }
    }
  }),
);
special("isempty", 1, ([f]) =>
  single((i, e) => {
    for (const _v of f.all(i, e)) return false;
    return true;
  }),
);

special("until", 2, ([cond, next]) => {
  const co = cond.one;
  const no = next.one;
  if (co && no) {
    return single((i, e) => {
      for (let v = i; ; ) {
        tick(1);
        const c = co(v, e);
        if (c === NONE) return NONE;
        if (truthy(c)) return v;
        v = no(v, e);
        if (v === NONE) return NONE;
      }
    });
  }
  // def _until: if cond then . else (next | _until) end
  function* go(v: unknown, e: Env): Generator<unknown> {
    tick(1);
    for (const c of cond.all(v, e)) {
      if (truthy(c)) yield v;
      else for (const w of next.all(v, e)) yield* go(w, e);
    }
  }
  return many(go);
});

special("while", 2, ([cond, update]) => {
  const co = cond.one;
  const uo = update.one;
  if (co && uo) {
    return many(function* (i, e) {
      for (let v = i; v !== NONE; v = uo(v, e)) {
        tick(1);
        const c = co(v, e);
        if (c === NONE || !truthy(c)) return;
        yield v;
      }
    });
  }
  // def _while: if cond then ., (update | _while) else empty end
  function* go(v: unknown, e: Env): Generator<unknown> {
    tick(1);
    for (const c of cond.all(v, e)) {
      if (!truthy(c)) continue;
      yield v;
      for (const w of update.all(v, e)) yield* go(w, e);
    }
  }
  return many(go);
});

// jq 1.7.1: `def repeat(f): def _repeat: f, _repeat; _repeat;`
special("repeat", 1, ([f]) =>
  many(function* (i, e) {
    for (;;) {
      tick(1);
      yield* f.all(i, e);
    }
  }),
);

/** any (wanted true) and all (wanted false): stop at the first condition that decides. */
function anyAll(source: Code, cond: Code, wanted: boolean): Code {
  return single((i, e) => {
    for (const x of source.all(i, e)) {
      for (const c of cond.all(x, e)) if (truthy(c) === wanted) return wanted;
    }
    return !wanted;
  });
}
const EACH = iterateOf(IDENTITY);
special("any", 0, () => anyAll(EACH, IDENTITY, true));
special("any", 1, ([f]) => anyAll(EACH, f, true));
special("any", 2, ([g, f]) => anyAll(g, f, true));
special("all", 0, () => anyAll(EACH, IDENTITY, false));
special("all", 1, ([f]) => anyAll(EACH, f, false));
special("all", 2, ([g, f]) => anyAll(g, f, false));

// --- Values ----------------------------------------------------------------

native("not", 0, (v) => !truthy(v));
native("length", 0, lengthOf);
native("utf8bytelength", 0, (v) => {
  if (typeof v !== "string") return fail(`${describe(v)} only strings have UTF-8 byte length`);
  tick(v.length >> 6);
  return utf8Length(v);
});
native("type", 0, kind);
native("keys", 0, (v) => keysOf(v, true));
native("keys_unsorted", 0, (v) => keysOf(v, false));
native("has", 1, has);
native("contains", 1, (a, b) => {
  if (rank(a) !== rank(b)) {
    return fail(`${describe(a)} and ${describe(b)} cannot have their containment checked`);
  }
  return contains(a, b);
});
native("add", 0, addAll);
native("to_entries", 0, toEntries);
native("from_entries", 0, fromEntries);
native("reverse", 0, reverse);
native("tostring", 0, toText);
native("tojson", 0, toJson);
native("fromjson", 0, fromJson);
native("tonumber", 0, toNumber);
native("explode", 0, explode);
native("implode", 0, implode);
native("ascii_downcase", 0, (v) => changeCase(v, false));
native("ascii_upcase", 0, (v) => changeCase(v, true));
native("trim", 0, (v) => trim(v, true, true));
native("ltrim", 0, (v) => trim(v, true, false));
native("rtrim", 0, (v) => trim(v, false, true));
native("ltrimstr", 1, (v, x) =>
  typeof v === "string" && typeof x === "string" && v.startsWith(x) ? v.slice(x.length) : v,
);
native("rtrimstr", 1, (v, x) =>
  typeof v === "string" && typeof x === "string" && x && v.endsWith(x) ? v.slice(0, -x.length) : v,
);
native("startswith", 1, (v, x) => {
  if (typeof v !== "string" || typeof x !== "string") {
    return fail("startswith() requires string inputs");
  }
  return v.startsWith(x);
});
native("endswith", 1, (v, x) => {
  if (typeof v !== "string" || typeof x !== "string") {
    return fail("endswith() requires string inputs");
  }
  return v.endsWith(x);
});
native("split", 1, (v, sep) => {
  if (typeof v !== "string" || typeof sep !== "string") {
    return fail("split input and separator must be strings");
  }
  return splitString(v, sep);
});
native("join", 1, joinStrings);
native("flatten", 0, (v) => flatten(v, -1));
native("flatten", 1, (v, depth) => {
  if (compare(depth, 0) < 0) return fail("flatten depth must not be negative");
  if (typeof depth !== "number") return fail(`${describe(depth)} is not a flatten depth`);
  return flatten(v, depth);
});
native("indices", 1, indices);
native("bsearch", 1, bsearch);
native("infinite", 0, () => Number.POSITIVE_INFINITY);
native("nan", 0, () => Number.NaN);
native("isinfinite", 0, (v) => v === Number.POSITIVE_INFINITY || v === Number.NEGATIVE_INFINITY);
native("isnan", 0, (v) => typeof v === "number" && Number.isNaN(v));
native("isnormal", 0, (v) => {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) >= 2.2250738585072014e-308;
});
native("now", 0, () => Date.now() / 1000);
// Never the real environment.
native("env", 0, () => ({}));

native("sort", 0, sortValues);
native("unique", 0, (v) => {
  iterate(v);
  if (!Array.isArray(v)) return fail(`${describe(v)} cannot be grouped, as it is not an array`);
  const sorted = sortValues(v);
  return sorted.filter((x, i) => i === 0 || compare(sorted[i - 1], x) !== 0);
});
native("min", 0, (v) => {
  if (!Array.isArray(v)) return fail(`${describe(v)} cannot be iterated over`);
  tick(v.length);
  return extreme(v, v, false);
});
native("max", 0, (v) => {
  if (!Array.isArray(v)) return fail(`${describe(v)} cannot be iterated over`);
  tick(v.length);
  return extreme(v, v, true);
});
special("sort_by", 1, ([f]) =>
  single((i, e) => {
    const { values, keys } = sortKeys(f, i, e, "sorted");
    return sortedOrder(keys).map((k) => values[k]);
  }),
);
special("group_by", 1, ([f]) =>
  single((i, e) => {
    const { values, keys } = sortKeys(f, i, e, "grouped");
    return groupBy(values, keys);
  }),
);
special("unique_by", 1, ([f]) =>
  single((i, e) => {
    const { values, keys } = sortKeys(f, i, e, "grouped");
    return groupBy(values, keys).map((g) => g[0]);
  }),
);
special("min_by", 1, ([f]) =>
  single((i, e) => {
    const { values, keys } = sortKeys(f, i, e, "iterated over");
    return extreme(values, keys, false);
  }),
);
special("max_by", 1, ([f]) =>
  single((i, e) => {
    const { values, keys } = sortKeys(f, i, e, "iterated over");
    return extreme(values, keys, true);
  }),
);

// --- Regular expressions ----------------------------------------------------

native("test", 1, (v, re) => testRegex(v, ...regexArgs(re)));
native("test", 2, testRegex);
stream("match", 1, (v, re) => matchAll(v, ...regexArgs(re)));
stream("match", 2, matchAll);

function* captures(s: unknown, pattern: unknown, flags: unknown): Generator<unknown> {
  const f = parseRegexFlags(flags);
  const rx = regexFor(pattern, f);
  for (const m of execAll(s, rx, f, false)) yield captureObject(m, rx);
}
stream("capture", 1, (v, re) => captures(v, ...regexArgs(re)));
stream("capture", 2, captures);
stream("scan", 1, (v, re) => scan(v, re, null));
stream("scan", 2, scan, true);
stream("splits", 1, (v, re) => splits(v, re, null));
stream("splits", 2, splits, true);
native("split", 2, (v, re, flags) => Array.from(splits(v, re, flags)), true);

/** sub and gsub: `$re` loops outermost, then the flags; the replacement runs once per match. */
function substitution(global: boolean): Make {
  return ([re, replacement, flags]) =>
    many(function* (i, e) {
      for (const pattern of re.all(i, e)) {
        if (!flags) {
          yield* substitute(i, pattern, global ? "g" : "", replacement, e);
          continue;
        }
        for (const f of flags.all(i, e)) {
          yield* substitute(i, pattern, global ? add(f, "g") : f, replacement, e);
        }
      }
    });
}
special("sub", 2, substitution(false));
special("sub", 3, substitution(false));
special("gsub", 2, substitution(true));
special("gsub", 3, substitution(true));

// --- Dates, formats, math ---------------------------------------------------

native("gmtime", 0, (v) => {
  const t = gmtime(v);
  return [t.year, t.month, t.day, t.hours, t.minutes, t.seconds, t.weekday, t.yearday];
});
native("mktime", 0, mktime);
native("strftime", 1, formatTime);
native("fromdateiso8601", 0, parseIsoDate);
native("format", 1, (v, name) => {
  if (typeof name !== "string") return fail(`${describe(name)} is not a valid format`);
  let f: (v: unknown) => string;
  try {
    f = formatter(name, 0);
  } catch {
    return fail(`${name} is not a valid format`);
  }
  return f(v);
});

for (const [name, f] of Object.entries(MATH1)) native(name, 0, (v) => f(numeric(v)));
for (const [name, f] of Object.entries(MATH2)) {
  native(name, 2, (_v, a, b) => f(numeric(a), numeric(b)));
}
native("fma", 3, (_v, a, b, c) => numeric(a) * numeric(b) + numeric(c));

// ---------------------------------------------------------------------------
// reduce in place. jq changes a value where it stands when nothing else holds
// it; here every change copies, so `reduce .[] as $x ({}; .[$x.k] = $x.v)`
// would copy the whole object each round. For updates of a few plain shapes
// the accumulator is copied once and then changed in place:
//   tail  := step ("|" step)* ["|" last]
//   step  := .path = e | .path |= f | .path op= e | . + e | setpath(p; e)
//   last  := e as $x | tail   or   if c then tail else tail end
// This is only done where the values written cannot contain the accumulator
// or what it holds (worked out by `flow`); anything else, and any step that
// does not have exactly one outcome, is evaluated the ordinary way.

type Step = (acc: unknown, env: Env, own: Owner) => unknown;

/** A step's answer when it cannot run in place; nothing has been changed then. */
const FALLBACK = Symbol("fallback");

// What a value may share with the accumulator.
const INNER = 1; // parts below its top
const ROOT = 2; // it may be the accumulator itself
const WRAPPED = 4; // it may contain the accumulator
const ANY = INNER | ROOT | WRAPPED;

const below = (s: number): number => (s & WRAPPED ? ANY : s & (ROOT | INNER) ? INNER : 0);
const wrap = (s: number): number => (s & INNER) | (s & (ROOT | WRAPPED) ? WRAPPED : 0);
/** What unknown code can make of values in state `s`. */
const anything = (s: number): number => (s === 0 || s === INNER ? s : ANY);

/** Builtins that only give new strings, numbers, booleans, null or arrays and objects of those. */
const FRESH_RESULTS = new Set([
  ...["empty", "error", "not", "length", "utf8bytelength", "type", "keys", "keys_unsorted", "has"],
  ...[
    "contains",
    "inside",
    "in",
    "tostring",
    "tojson",
    "tonumber",
    "fromjson",
    "explode",
    "implode",
  ],
  ...[
    "ascii_downcase",
    "ascii_upcase",
    "ascii",
    "trim",
    "ltrim",
    "rtrim",
    "startswith",
    "endswith",
  ],
  ...["split", "splits", "join", "test", "match", "capture", "scan", "sub", "gsub", "any", "all"],
  ...["isempty", "range", "isnan", "isinfinite", "isnormal", "infinite", "nan", "now", "bsearch"],
  ...["gmtime", "mktime", "strftime", "todate", "fromdate", "todateiso8601", "fromdateiso8601"],
  ...["date", "format", "IN", "fma", ...Object.keys(MATH1), ...Object.keys(MATH2)],
]);

function patternNames(pat: Pattern, out: string[] = []): string[] {
  if (pat.t === "pvar") out.push(pat.name);
  else if (pat.t === "parr") for (const item of pat.items) patternNames(item, out);
  else {
    for (const entry of pat.entries) {
      if (entry.name !== null) out.push(entry.name);
      if (entry.value) patternNames(entry.value, out);
    }
  }
  return out;
}

function userDefined(name: string, arity: number, sc: Sc | null): boolean {
  for (let s = sc; s; s = s.up) {
    if (s.name !== name) continue;
    if (s.kind === "fn" ? s.fn?.params.length === arity : arity === 0 && s.kind !== "label") {
      return true;
    }
  }
  return false;
}

const scalarLiteral = (n: Node): boolean =>
  n.t === "str" || (n.t === "lit" && (typeof n.v === "number" || typeof n.v === "string"));

/**
 * What the outputs of `n` may share with the accumulator, given what its
 * input (`input`) and the variables bound inside the update (`vars`) may.
 */
function flow(n: Node, input: number, vars: Map<string, number>, sc: Sc | null): number {
  const sub = (x: Node, i = input, v = vars): number => flow(x, i, v, sc);
  const bound = (pat: Pattern, s: number): Map<string, number> => {
    const next = new Map(vars);
    for (const name of patternNames(pat)) next.set(name, pat.t === "pvar" ? s : s | below(s));
    return next;
  };
  switch (n.t) {
    case "id":
      return input;
    case "rec":
      return input | below(input);
    case "lit":
    case "loc":
    case "str":
    case "fmt":
    case "neg":
    case "and":
    case "or":
    case "break":
      return 0;
    case "var":
      return vars.get(n.name) ?? 0;
    case "idx":
    case "slice":
    case "iter":
      return below(sub(n.of));
    case "arr":
      return n.body ? wrap(sub(n.body)) : 0;
    case "obj":
      return wrap(n.entries.reduce((s, entry) => s | sub(entry.value), 0));
    case "pipe":
      return sub(n.r, sub(n.l));
    case "comma":
    case "alt":
      return sub(n.l) | sub(n.r);
    case "bin": {
      if (COMPARE_OPS.has(n.op) || n.op === "/" || n.op === "%") return 0;
      if (scalarLiteral(n.l) || scalarLiteral(n.r)) return 0;
      const s = sub(n.l) | sub(n.r);
      return s | below(s);
    }
    case "if":
      return sub(n.then) | (n.else ? sub(n.else) : input);
    case "try":
      return sub(n.body) | (n.handler ? sub(n.handler, ANY) : 0);
    case "as":
      return sub(n.body, input, bound(n.pat, sub(n.src)));
    case "reduce":
    case "foreach": {
      const inner = bound(n.pat, sub(n.src));
      let acc = sub(n.init);
      for (let k = 0; k < 4; k++) acc |= flow(n.update, acc, inner, sc);
      return n.t === "foreach" && n.extract ? flow(n.extract, acc, inner, sc) : acc;
    }
    case "label":
      return sub(n.body);
    case "def":
      return ANY;
    case "assign": {
      const s = input | sub(n.r, input | below(input));
      const t = s | below(s);
      return t | wrap(t);
    }
    case "call": {
      const known = !userDefined(n.name, n.args.length, sc);
      if (known && FRESH_RESULTS.has(n.name)) return 0;
      if (known && n.name === "select" && n.args.length === 1) return input;
      let s = input;
      for (let k = 0; k < 4; k++) for (const a of n.args) s |= sub(a, anything(s));
      return anything(s);
    }
  }
}

/** The single output of `code`, or NONE when it has none or several. */
function only(code: Code, input: unknown, env: Env): unknown {
  if (code.one) return code.one(input, env);
  let out: unknown = NONE;
  for (const v of code.all(input, env)) {
    if (out !== NONE) return NONE;
    out = v;
  }
  return out;
}

/** Forgets every held container but the accumulator itself. */
function keepRoot(own: Owner, acc: unknown): void {
  const held = isContainer(acc) && owns(own, acc);
  own.epoch++;
  if (held) own.tags.set(acc as object, own.epoch);
}

/** The key expressions of `.a[b].c`, outermost last; null for anything else. */
function plainPath(n: Node): Node[] | null {
  const keys: Node[] = [];
  let cur = n;
  while (cur.t === "idx") {
    keys.push(cur.key);
    cur = cur.of;
  }
  return cur.t === "id" && keys.length ? keys.reverse() : null;
}

/** Writes `next` over `old` at `path`, in place where the containers are held. */
function store(acc: unknown, path: Path, next: unknown, old: unknown, own: Owner): unknown {
  const out = setPath(acc, path, 0, next, own);
  if (next !== old && isContainer(next)) keepOnly(own, out, path);
  return out;
}

/** `old + x` at `path`, growing a held array or object instead of copying it. */
function grow(acc: unknown, path: Path, old: unknown, x: unknown, own: Owner): unknown {
  if (Array.isArray(old) && Array.isArray(x)) {
    const target = mine(old, own);
    tick(x.length);
    for (const item of x) target.push(item);
    return setPath(acc, path, 0, target, own);
  }
  if (isObj(old) && isObj(x)) {
    const target = mine(old, own);
    const keys = Object.keys(x);
    tick(keys.length);
    for (const k of keys) put(target, k, x[k]);
    return setPath(acc, path, 0, target, own);
  }
  return store(acc, path, add(old, x), old, own);
}

function stepOf(n: Node, sc: Sc | null, vars: Map<string, number>): Step | null {
  let keyNodes: Node[] | null = null;
  let pathNode: Node | null = null;
  let valueNode: Node;
  let op: string;
  if (n.t === "assign") {
    keyNodes = plainPath(n.l);
    if (!keyNodes) return null;
    valueNode = n.r;
    op = n.op === "|=" || n.op === "=" ? n.op : n.op.slice(0, -1);
  } else if (n.t === "bin" && n.op === "+" && n.l.t === "id") {
    keyNodes = [];
    valueNode = n.r;
    op = "+";
  } else if (n.t === "call" && n.name === "setpath" && n.args.length === 2) {
    if (userDefined("setpath", 2, sc)) return null;
    pathNode = n.args[0];
    valueNode = n.args[1];
    op = "=";
  } else {
    return null;
  }
  const state = op === "|=" ? 0 : flow(valueNode, ROOT, vars, sc);
  if (state !== 0 && state !== INNER) return null;
  const keys = (keyNodes ?? []).map((k) => comp(k, sc));
  const whole = pathNode ? comp(pathNode, sc) : null;
  const value = comp(valueNode, sc);
  const f: Binary | null =
    op === "=" || op === "|=" ? null : op === "//" ? (a, b) => (truthy(a) ? a : b) : BINARY[op];
  return (acc, env, own) => {
    // Everything is read before anything is written.
    const x = op === "|=" ? null : only(value, acc, env);
    if (x === NONE) return FALLBACK;
    let path: Path = [];
    if (whole) {
      const p = only(whole, acc, env);
      if (!Array.isArray(p)) return FALLBACK;
      path = p;
    } else {
      for (const key of keys) {
        const k = only(key, acc, env);
        if (k === NONE) return FALLBACK;
        path.push(k);
      }
    }
    if (!path.every((k) => typeof k === "string" || typeof k === "number")) return FALLBACK;
    if (op === "|=") {
      const old = getPath(acc, path);
      const next = firstOf(value, old, env);
      return next === NONE ? FALLBACK : store(acc, path, next, old, own);
    }
    if (state === INNER && isContainer(x)) keepRoot(own, acc);
    if (!f) return setPath(acc, path, 0, x, own);
    const old = getPath(acc, path);
    if (op === "+") return grow(acc, path, old, x, own);
    return store(acc, path, f(old, x), old, own);
  };
}

function flattenPipe(n: Node, out: Node[] = []): Node[] {
  if (n.t === "pipe") {
    flattenPipe(n.l, out);
    flattenPipe(n.r, out);
  } else out.push(n);
  return out;
}

/** The update `n` as steps in place, or null when no part of it can be. */
function tailOf(n: Node, sc: Sc | null, vars: Map<string, number>): Step | null {
  const nodes = flattenPipe(n);
  const steps: Step[] = [];
  let real = false;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    let step: Step | null = node.t === "id" ? (acc) => acc : stepOf(node, sc, vars);
    if (step && node.t !== "id") real = true;
    if (!step && isLast) {
      step = closingStep(node, sc, vars);
      if (step) real = true;
    }
    if (!step && !isLast) return null;
    // A last node that cannot run in place is evaluated the ordinary way.
    steps.push(step ?? (() => FALLBACK));
  }
  if (!real) return null;
  // The rest of the pipeline from each node on, compiled when first needed.
  const rest: (Code | null)[] = nodes.map(() => null);
  const ordinary = (from: number, acc: unknown, env: Env, own: Owner): unknown => {
    if (!rest[from]) {
      let node = nodes[nodes.length - 1];
      for (let i = nodes.length - 2; i >= from; i--) {
        node = { t: "pipe", pos: nodes[i].pos, l: nodes[i], r: node };
      }
      rest[from] = comp(node, sc);
    }
    let last: unknown = NONE;
    for (const v of (rest[from] as Code).all(acc, env)) last = v;
    // What came out may share anything with what went in.
    if (last !== acc) own.epoch++;
    return last;
  };
  return (acc, env, own) => {
    let cur = acc;
    for (let i = 0; i < steps.length; i++) {
      const next = steps[i](cur, env, own);
      if (next === FALLBACK) return ordinary(i, cur, env, own);
      cur = next;
    }
    return cur;
  };
}

/** `e as $x | tail` and `if c then tail else tail end`, which may only come last. */
function closingStep(n: Node, sc: Sc | null, vars: Map<string, number>): Step | null {
  if (n.t === "as") {
    const state = flow(n.src, ROOT, vars, sc);
    if (state !== 0 && state !== INNER) return null;
    const binder = compPattern(n.pat, sc);
    const inner = new Map(vars);
    for (const name of patternNames(n.pat)) inner.set(name, state);
    const body = tailOf(n.body, binder.sc, inner);
    if (!body) return null;
    const src = comp(n.src, sc);
    return (acc, env, own) => {
      const v = only(src, acc, env);
      if (v === NONE) return FALLBACK;
      let bound: Env | typeof NONE = NONE;
      if (binder.one) bound = binder.one(v, env);
      else {
        for (const e of binder.all(v, env)) {
          if (bound !== NONE) return FALLBACK;
          bound = e;
        }
      }
      if (bound === NONE) return FALLBACK;
      // The variable must not see later changes: let go of what it may hold.
      if (state === INNER) keepRoot(own, acc);
      return body(acc, bound, own);
    };
  }
  if (n.t === "if") {
    const then = tailOf(n.then, sc, vars);
    const otherwise = n.else ? tailOf(n.else, sc, vars) : null;
    if (!then && !otherwise) return null;
    const cond = comp(n.cond, sc);
    const branch = (node: Node | null, tail: Step | null): Step => {
      if (tail) return tail;
      if (!node || node.t === "id") return (acc) => acc;
      const code = comp(node, sc);
      return (acc, env, own) => {
        let last: unknown = NONE;
        for (const v of code.all(acc, env)) last = v;
        if (last !== acc) own.epoch++;
        return last;
      };
    };
    const yes = branch(n.then, then);
    const no = branch(n.else, otherwise);
    return (acc, env, own) => {
      const c = only(cond, acc, env);
      if (c === NONE) return FALLBACK;
      return (truthy(c) ? yes : no)(acc, env, own);
    };
  }
  return null;
}

function inPlace(update: Node, sc: Sc | null): Step | null {
  return tailOf(update, sc, new Map());
}

// ---------------------------------------------------------------------------
// Free variables and what is read from them

function analyze(root: Node): { freeVars: string[]; refs: string[][] } {
  interface Bound {
    name: string;
    up: Bound | null;
  }
  const free = new Set<string>();
  const refs: string[][] = [];
  const seen = new Set<string>();
  const isFree = (name: string, b: Bound | null): boolean => {
    if (name === "ENV" || name === "__prog_args") return false;
    for (let s = b; s; s = s.up) if (s.name === name) return false;
    return true;
  };
  const read = (path: string[]): void => {
    free.add(path[0]);
    const key = JSON.stringify(path);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(path);
  };
  const bind = (pat: Pattern, b: Bound | null): Bound | null => {
    let cur = b;
    if (pat.t === "pvar") return { name: pat.name, up: cur };
    if (pat.t === "parr") {
      for (const item of pat.items) cur = bind(item, cur);
      return cur;
    }
    for (const entry of pat.entries) {
      if (entry.name !== null) cur = { name: entry.name, up: cur };
      if (entry.key) visit(entry.key, cur);
      if (entry.value) cur = bind(entry.value, cur);
    }
    return cur;
  };
  /** `$free.a.b[...]...`: records the literal field path and visits the keys. */
  const chain = (n: Node, b: Bound | null): boolean => {
    const links: Node[] = [];
    let cur = n;
    for (;;) {
      if (cur.t === "idx" || cur.t === "slice" || cur.t === "iter") {
        links.push(cur);
        cur = cur.of;
      } else if (cur.t === "try" && !cur.handler) {
        cur = cur.body;
      } else break;
    }
    if (cur.t !== "var" || !isFree(cur.name, b)) return false;
    const path = [cur.name];
    let literal = true;
    for (let i = links.length - 1; i >= 0; i--) {
      const link = links[i];
      if (literal && link.t === "idx" && link.key.t === "lit" && typeof link.key.v === "string") {
        path.push(link.key.v);
      } else literal = false;
      if (link.t === "idx") visit(link.key, b);
      if (link.t === "slice") {
        if (link.from) visit(link.from, b);
        if (link.to) visit(link.to, b);
      }
    }
    read(path);
    return true;
  };
  const visit = (n: Node, b: Bound | null): void => {
    switch (n.t) {
      case "var":
        if (isFree(n.name, b)) read([n.name]);
        return;
      case "idx":
      case "slice":
      case "iter":
        if (chain(n, b)) return;
        visit(n.of, b);
        if (n.t === "idx") visit(n.key, b);
        if (n.t === "slice") {
          if (n.from) visit(n.from, b);
          if (n.to) visit(n.to, b);
        }
        return;
      case "try":
        if (!n.handler && chain(n, b)) return;
        visit(n.body, b);
        if (n.handler) visit(n.handler, b);
        return;
      case "str":
        for (const part of n.parts) if (typeof part !== "string") visit(part, b);
        return;
      case "arr":
        if (n.body) visit(n.body, b);
        return;
      case "obj":
        for (const entry of n.entries) {
          visit(entry.key, b);
          visit(entry.value, b);
        }
        return;
      case "neg":
        visit(n.of, b);
        return;
      case "pipe":
      case "comma":
      case "and":
      case "or":
      case "alt":
      case "bin":
      case "assign":
        visit(n.l, b);
        visit(n.r, b);
        return;
      case "if":
        visit(n.cond, b);
        visit(n.then, b);
        if (n.else) visit(n.else, b);
        return;
      case "reduce":
      case "foreach": {
        visit(n.src, b);
        visit(n.init, b);
        const inner = bind(n.pat, b);
        visit(n.update, inner);
        if (n.t === "foreach" && n.extract) visit(n.extract, inner);
        return;
      }
      case "def": {
        let inner = b;
        for (const p of n.params) if (p.isVar) inner = { name: p.name, up: inner };
        visit(n.body, inner);
        visit(n.rest, b);
        return;
      }
      case "call":
        for (const a of n.args) visit(a, b);
        return;
      case "as":
        visit(n.src, b);
        visit(n.body, bind(n.pat, b));
        return;
      case "label":
        visit(n.body, b);
        return;
      default:
        return;
    }
  };
  visit(root, null);
  return { freeVars: [...free].sort(), refs };
}

// ---------------------------------------------------------------------------
// The public face

function toJqError(x: unknown): JqError {
  if (x instanceof JqError) return x;
  if (x instanceof Thrown) {
    let message = "jq: error";
    try {
      const out: string[] = [];
      if (typeof x.value !== "string") writeJson(x.value, out, { left: 300 });
      message =
        typeof x.value === "string"
          ? `jq: error: ${x.value.length > 2000 ? `${x.value.slice(0, 2000)}...` : x.value}`
          : `jq: error (not a string): ${out.join("")}`;
    } catch {
      // The value could not be printed within the budget.
    }
    const e = new JqError(message);
    e.value = x.value;
    return e;
  }
  if (x instanceof BreakSignal) return new JqError("jq: break outside its label");
  if (x instanceof RangeError) {
    return new JqError(
      /call stack/i.test(x.message)
        ? "jq: the program or its data is nested too deeply, or it recursed too deeply"
        : `jq: ${x.message}`,
    );
  }
  return new JqError(`jq: internal error: ${x instanceof Error ? x.message : String(x)}`);
}

const limitOf = (given: unknown, normal: number): number =>
  typeof given === "number" && given >= 0 ? given : normal;

/** Stops an output that would be enormous once written out (values can share parts). */
function checkOutputs(values: unknown[], limit: number): void {
  let units = 0;
  const walk = (v: unknown): void => {
    units += typeof v === "string" ? 1 + (v.length >> 8) : 1;
    if (units > limit) throw new JqError("jq: the output is too large");
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (isObj(v)) for (const k of Object.keys(v)) walk(v[k]);
  };
  for (const v of values) walk(v);
}

/** Parses and checks a program: syntax, unknown functions (name/arity), unsupported features. Throws JqError with position. */
export function compile(source: string): Program {
  let code: Code;
  let freeVars: string[];
  let refs: string[][];
  try {
    if (typeof source !== "string") throw new JqError("jq: the program must be a string");
    const tree = parse(source);
    const read = analyze(tree);
    freeVars = read.freeVars;
    refs = read.refs;
    let sc: Sc | null = null;
    for (const name of freeVars) sc = bindVar(sc, name);
    code = comp(tree, sc);
  } catch (x) {
    throw toJqError(x);
  }
  return {
    source,
    freeVars,
    refs,
    run(input: unknown, options: JqOptions = {}): unknown[] {
      const saved = [ops, opsLimit, strLimit];
      ops = 0;
      opsLimit = limitOf(options.maxOps, DEFAULT_MAX_OPS);
      strLimit = limitOf(options.maxString, DEFAULT_MAX_STRING);
      const maxOutputs = limitOf(options.maxOutputs, DEFAULT_MAX_OUTPUTS);
      try {
        const vars = options.vars ?? {};
        let env: Env = null;
        for (const name of freeVars) {
          if (!Object.hasOwn(vars, name)) throw new JqError(`jq: $${name} is not defined`);
          const v = vars[name];
          env = { v: v === undefined ? null : v, up: env };
        }
        const out: unknown[] = [];
        for (const v of code.all(input === undefined ? null : input, env)) {
          if (out.length >= maxOutputs) {
            throw new JqError(`jq: the program gave more than ${maxOutputs} outputs (maxOutputs)`);
          }
          out.push(v);
        }
        checkOutputs(out, Math.max(opsLimit, 1_000_000));
        return out;
      } catch (x) {
        throw toJqError(x);
      } finally {
        [ops, opsLimit, strLimit] = saved;
      }
    },
  };
}

/** compile(source).run(input, options) */
export function run(source: string, input: unknown, options?: JqOptions): unknown[] {
  return compile(source).run(input, options);
}
