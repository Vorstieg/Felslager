import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "../config.js";
import { createUser } from "../auth.js";
if (!stdin.isTTY)
  throw new Error("User creation requires an interactive terminal");
const rl = readline.createInterface({ input: stdin, output: stdout });
const name = await rl.question("Name: "),
  email = await rl.question("Email: ");
rl.close();
async function hidden(prompt) {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const handler = (data) => {
      for (const ch of data.toString()) {
        if (ch === "\u0003") {
          cleanup();
          reject(new Error("Cancelled"));
          return;
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === "\u007f") {
          value = value.slice(0, -1);
        } else if (ch >= " ") value += ch;
      }
    };
    const cleanup = () => {
      stdin.off("data", handler);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    stdin.on("data", handler);
  });
}
const password = await hidden("Password (12–128 characters): "),
  confirmation = await hidden("Repeat password: ");
if (password !== confirmation || password.length < 12 || password.length > 128)
  throw new Error("Passwords must match and contain 12–128 characters");
await createUser(loadConfig(), {
  name: name.trim(),
  email: email.trim(),
  password,
});
console.log("User created. This account can edit content.");
