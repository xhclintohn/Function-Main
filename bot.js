import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  useMultiFileAuthState,
} from "baileys-pro";
import pino from "pino";
import NodeCache from "node-cache";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { saveUserDetails } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionDir = path.join(__dirname, "session");
const logger = pino({ level: "silent" });
const msgRetryCounterCache = new NodeCache();
const activeBots = new Map();

await fs.mkdir(sessionDir, { recursive: true });

export async function startBot(botName, ownerNumber, sessionId) {
  if (activeBots.has(botName)) return;

  try {
    if (!(await loadBase64Session(sessionId, botName))) {
      throw new Error("Invalid session ID");
    }

    const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, `session_${botName}`));
    const { version } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
      version,
      logger,
      browser: [botName, "Chrome", "1.0.0"],
      auth: state,
      msgRetryCounterCache,
      getMessage: async (key) => ({ conversation: `${botName} WhatsApp bot` }),
    });

    activeBots.set(botName, conn);

    conn.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "close") {
        activeBots.delete(botName);
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.loggedOut) {
          await saveUserDetails(null, botName, ownerNumber, sessionId, "disconnected");
        } else {
          startBot(botName, ownerNumber, sessionId);
        }
      } else if (connection === "open") {
        await saveUserDetails(null, botName, ownerNumber, sessionId, "connected");
        await conn.sendMessage(conn.user.id, {
          text: "◈━━━━━━━━━━━━━━━━◈\n│❒ Bot connected successfully ✅\n◈━━━━━━━━━━━━━━━━◈",
        });
      }
    });

    conn.ev.on("creds.update", saveCreds);

    conn.ev.on("messages.upsert", async (chatUpdate) => {
      const mek = chatUpdate.messages[0];
      if (!mek || !mek.message || mek.key.remoteJid !== "status@broadcast") return;

      // Autoview
      await conn.readMessages([mek.key]);

      // Autolike
      const emojis = ["😄", "🔥", "❤️", "👍", "😎", "🚀", "💯", "🌟"];
      const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
      await conn.sendMessage(mek.key.remoteJid, {
        react: { text: randomEmoji, key: mek.key },
      }, { statusJidList: [mek.key.participant, await conn.decodeJid(conn.user.id)] });
    });

    conn.public = true; // Multi-device support
  } catch (error) {
    activeBots.delete(botName);
    await saveUserDetails(null, botName, ownerNumber, sessionId, "error");
    throw error;
  }
}

export async function stopBot(botName) {
  const conn = activeBots.get(botName);
  if (conn) {
    try {
      await conn.end();
    } catch {}
    activeBots.delete(botName);
  }
}

async function loadBase64Session(sessionId, botName) {
  const credsPath = path.join(sessionDir, `creds_${botName}.json`);
  try {
    const credsBuffer = Buffer.from(sessionId, "base64");
    await fs.writeFile(credsPath, credsBuffer);
    return true;
  } catch {
    return false;
  }
}