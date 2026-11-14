// What the user of this computer decided, kept so that a file can't say it
// for them. A project folder is not trusted: a cloned repository can ship its
// own `.encela/` with a blueprint that says "approved" or a run that says
// "waiting". An approval or a run counts only when it carries a seal made
// with a key that never leaves the user's Encela folder.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY = /^[0-9a-f]{64}$/;

export class Seals {
  private key: Buffer | null = null;

  /** `home` is the user's Encela folder (`~/.encela`). */
  constructor(private home: string) {}

  private read(file: string): Buffer | null {
    try {
      const hex = readFileSync(file, "utf8").trim();
      return KEY.test(hex) ? Buffer.from(hex, "hex") : null;
    } catch {
      return null;
    }
  }

  /** The key, made the first time it is needed. */
  private secret(): Buffer {
    if (this.key) return this.key;
    const file = join(this.home, "key");
    let key = this.read(file);
    if (!key) {
      mkdirSync(this.home, { recursive: true });
      key = randomBytes(32);
      try {
        writeFileSync(file, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
      } catch {
        // Another server of this user wrote it first, or the file is damaged.
        const theirs = this.read(file);
        if (theirs) key = theirs;
        else writeFileSync(file, `${key.toString("hex")}\n`, { mode: 0o600 });
      }
    }
    this.key = key;
    return key;
  }

  /** A seal over some facts, in order. */
  sign(...facts: string[]): string {
    return createHmac("sha256", this.secret()).update(JSON.stringify(facts)).digest("hex");
  }

  /** Whether `seal` is this computer's seal over exactly these facts. */
  matches(seal: unknown, ...facts: string[]): boolean {
    if (typeof seal !== "string" || !KEY.test(seal)) return false;
    return timingSafeEqual(Buffer.from(seal, "hex"), Buffer.from(this.sign(...facts), "hex"));
  }
}

/** A folder as the system knows it, so that two spellings of one place give one seal. */
export function place(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}
