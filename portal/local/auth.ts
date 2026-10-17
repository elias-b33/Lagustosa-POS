import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newSecret() {
  return Array.from(randomBytes(32), (n) => alphabet[n % 32]).join("");
}
function base32(text: string) {
  let bits = "";
  for (const char of text.toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Ogiltig TOTP-nyckel.");
    bits += value.toString(2).padStart(5, "0");
  }
  return Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
}
export function totp(secret: string, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
export function verifyTotp(secret: string, code: string, at = Date.now()) {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((step) =>
    timingSafeEqual(
      Buffer.from(totp(secret, at + step * 30000)),
      Buffer.from(code),
    ),
  );
}
export function passwordHash(
  value: string,
  salt = randomBytes(16).toString("hex"),
) {
  return `${salt}:${scryptSync(value, salt, 32).toString("hex")}`;
}
export function passwordMatches(value: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const actual = Buffer.from(passwordHash(value, salt).split(":")[1], "hex");
  return timingSafeEqual(actual, Buffer.from(hash, "hex"));
}
