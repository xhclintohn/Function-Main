import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from "baileys-pro";
import pino from "pino";
import NodeCache from "node-cache";
import { saveUserDetails } from "./utils.js";

const logger = pino({ level: "silent" });
const msgRetryCounterCache = new NodeCache();
const activeBots = new Map();

export async function startBot(pool, botName, ownerNumber, sessionId) {
  if (activeBots.has(botName)) return;

  try {
    // Load or initialize session
    const { version } = await fetchLatestBaileysVersion();
    const credsResult = await pool.query("SELECT creds FROM sessions WHERE botName = $1", [botName]);
    let state = credsResult.rows[0]?.creds ? JSON.parse(credsResult.rows[0].creds) : { creds: {}, keys: {} };

    const saveCreds = async () => {
      try {
        await pool.query(
          `INSERT INTO sessions (botName, creds)
           VALUES ($1, $2)
           ON CONFLICT (botName) DO UPDATE
           SET creds = $2`,
          [botName, JSON.stringify(state)]
        );
      } catch (error) {
        console.error(`Failed to save creds for ${botName}:`, error.message);
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
          await saveUserDetails(pool, botName, ownerNumber, sessionId, "disconnected");
          await pool.query("DELETE FROM sessions WHERE botName = $1", [botName]);
        } else {
          startBot(pool, botName, ownerNumber, sessionId);
        }
      } else if (connection === "open") {
        await saveUserDetails(pool, botName, ownerNumber, sessionId, "connected");
        await conn.sendMessage(conn.user.id, {
          text: "◈━━━━━━━━━━━━━━━━◈\n│❒ Bot connected successfully ✅\n◈━━━━━━━━━━━━━━━━◈",
        });
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
    if (!credsResult.rows[0]) {
      try {
        const credsBuffer = Buffer.from(sessionId, "base64");
        state.creds = JSON.parse(credsBuffer.toString());
        await saveCreds();
      } catch (error) {
        console.error(`Invalid session ID for ${botName}:`, error.message);
        throw new Error("Invalid session ID");
      }
    }
  } catch (error) {
    activeBots.delete(botName);
    await saveUserDetails(pool, botName, ownerNumber, sessionId, "error");
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