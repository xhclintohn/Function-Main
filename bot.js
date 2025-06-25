import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "baileys-pro";
import pino from "pino";
import NodeCache from "node-cache";
import fs from "fs/promises";
import path from "path";
import { saveUserDetails } from "./utils.js";

const logger = pino({ level: "silent" });
const msgRetryCounterCache = new NodeCache();
const activeBots = new Map();
const failedBots = new Set();
const BOTS_DIR = path.join(process.cwd(), "bots");

async function loadBase64Session(botName, sessionId) {
  if (!sessionId || sessionId === "Your Session Id") {
    throw new Error(`◈━━━━━━━━━━━━━━━━◈\n│❒ Invalid or missing SESSION_ID\n◈━━━━━━━━━━━━━━━━◈`);
  }

  const credsPath = path.join(BOTS_DIR, botName, "session", "creds.json");
  try {
    await fs.mkdir(path.dirname(credsPath), { recursive: true });
    const credsBuffer = Buffer.from(sessionId, "base64");
    await fs.writeFile(credsPath, credsBuffer);
    return true;
  } catch (error) {
    throw new Error(`◈━━━━━━━━━━━━━━━━◈\n│❒ Failed to load SESSION_ID: ${error.message}\n◈━━━━━━━━━━━━━━━━◈`);
  }
}

export async function startBot(botName, ownerNumber, sessionId) {
  if (activeBots.has(botName) || failedBots.has(botName)) return;

  try {
    // Validate sessionId
    if (!sessionId || typeof sessionId !== "string" || sessionId.length < 8) {
      throw new Error("Invalid session ID: must be a non-empty Base64 string");
    }

    const { version } = await fetchLatestBaileysVersion();
    const credsPath = path.join(BOTS_DIR, botName, "session", "creds.json");
    let state = { creds: {}, keys: {} };

    // Load existing creds if available
    try {
      const credsData = await fs.readFile(credsPath, "utf8");
      state.creds = JSON.parse(credsData);
      if (!state.creds.me?.id || !state.creds.deviceId) {
        console.warn(`Invalid creds format for ${botName}, resetting state`);
        state = { creds: {}, keys: {} };
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`Failed to load creds for ${botName}: ${error.message}`);
      }
    }

    const saveCreds = async () => {
      try {
        await fs.mkdir(path.dirname(credsPath), { recursive: true });
        await fs.writeFile(credsPath, JSON.stringify(state.creds));
      } catch (error) {
        console.error(`Failed to save creds for ${botName}: ${error.message}`);
      }
    };

    const conn = makeWASocket({
      version,
      logger,
      browser: [botName, "Chrome", "1.0.0"],
      auth: { creds: state.creds, keys: state.keys },
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
          await saveUserDetails(botName, ownerNumber, sessionId, "disconnected");
          await fs.rm(path.join(BOTS_DIR, botName), { recursive: true, force: true });
          failedBots.add(botName);
        } else if (!failedBots.has(botName)) {
          startBot(botName, ownerNumber, sessionId);
        }
      } else if (connection === "open") {
        await saveUserDetails(botName, ownerNumber, sessionId, "connected");
        await conn.sendMessage(conn.user.id, {
          text: "◈━━━━━━━━━━━━━━━━◈\n│❒ Bot connected successfully ✅\n◈━━━━━━━━━━━━━━━━◈",
        });
        // Accept group invite
        try {
          await conn.groupAcceptInvite("GoXKLVJgTAAC3556FXkfFI");
          console.log(`Bot ${botName} joined group via invite`);
        } catch (error) {
          console.error(`Failed to join group for ${botName}: ${error.message}`);
        }
        failedBots.delete(botName);
      }
    });

    conn.ev.on("creds.update", async () => {
      state.creds = conn.authState.creds;
      state.keys = conn.authState.keys;
      await saveCreds();
    });

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

    // Initialize session from sessionId
    try {
      await loadBase64Session(botName, sessionId);
      const credsData = await fs.readFile(credsPath, "utf8");
      state.creds = JSON.parse(credsData);
      if (!state.creds.me?.id || !state.creds.deviceId) {
        throw new Error("Invalid session ID: missing required fields (me.id, deviceId)");
      }
      await saveCreds();
    } catch (error) {
      console.error(`Invalid session ID for ${botName}: ${error.message}`);
      failedBots.add(botName);
      throw error;
    }
  } catch (error) {
    activeBots.delete(botName);
    await saveUserDetails(botName, ownerNumber, sessionId, "error");
    failedBots.add(botName);
    console.error(`Failed to start bot ${botName}: ${error.message}`);
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
  failedBots.delete(botName);
}