// Usage: pnpm hash-password '<password>'   (or run without args to be prompted)
import { hash } from "@node-rs/argon2";
import { createInterface } from "node:readline/promises";

async function main() {
  let password = process.argv[2];
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question("Password: ");
    rl.close();
  }
  if (!password || password.length < 12) {
    console.error("Use a password of at least 12 characters.");
    process.exit(1);
  }
  const h = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  console.log(`\nFor Vercel (paste the value as-is):\nADMIN_PASSWORD_HASH=${h}`);
  // Next.js expands $VARS in .env files, so every $ must be escaped there.
  console.log(`\nFor a local .env file:\nADMIN_PASSWORD_HASH=${h.replace(/\$/g, "\\$")}`);
}

void main();
