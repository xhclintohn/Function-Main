import {
  makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  useMultiFileAuthState,
} from "baileys-pro";
import express from "express";
import rateLimit from "express-rate-limit";
import pino from "pino";
import fs from "fs";
import path from "path";
import NodeCache from "node-cache";

const app = express();
const PORT = process.env.PORT || 3000;
const logger = pino({ level: "silent" });
const msgRetryCounterCache = new NodeCache();
const MAX_BOTS = 50; // Limit to prevent spam

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const sessionDir = path.join(__dirname, "session");
const connectedUsersDir = path.join(__dirname, "ConnectedUsers");

if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
if (!fs.existsSync(connectedUsersDir)) fs.mkdirSync(connectedUsersDir, { recursive: true });

// Save user details to ConnectedUsers/<bot_name>.json
async function saveUserDetails(botName, ownerNumber, sessionId, status = "disconnected") {
  const userData = { botName, ownerNumber, sessionId, status, connectedAt: new Date().toISOString() };
  const filePath = path.join(connectedUsersDir, `${botName}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(userData, null, 2));
}

// Load Base64 session
async function loadBase64Session(sessionId, botName) {
  const credsPath = path.join(sessionDir, `creds_${botName}.json`);
  try {
    const credsBuffer = Buffer.from(sessionId, "base64");
    await fs.promises.writeFile(credsPath, credsBuffer);
    return true;
  } catch (error) {
    return false;
  }
}

// Start bot instance
async function startBot(botName, ownerNumber, sessionId) {
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

    conn.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.loggedOut) {
          await saveUserDetails(botName, ownerNumber, sessionId, "disconnected");
        } else {
          startBot(botName, ownerNumber, sessionId);
        }
      } else if (connection === "open") {
        await saveUserDetails(botName, ownerNumber, sessionId, "connected");
      }
    });

    conn.ev.on("creds.update", saveCreds);

    conn.ev.on("messages.upsert", async (chatUpdate) => {
      const mek = chatUpdate.messages[0];
      if (!mek || !mek.message || mek.key.remoteJid !== "status@broadcast") return;

      // Autoview status
      await conn.readMessages([mek.key]);

      // Autolike status
      const autolikeEmojis = ['🗿', '⌚️', '💠', '👣', '🍆', '💔', '🤍', '❤️‍🔥', '💣', '🧠', '🦅', '🌻', '🧊', '🛑', '🧸', '👑', '📍', '😅', '🎭', '🎉', '😳', '💯', '🔥', '💫', '🐒', '💗', '❤️‍🔥', '👁️', '👀', '🙌', '🙆', '🌟', '💧', '🦄', '🟢', '🎎', '✅', '🥱', '🌚', '💚', '💕', '😉', '😒'];
      const randomEmoji = autolikeEmojis[Math.floor(Math.random() * autolikeEmojis.length)];
      await conn.sendMessage(mek.key.remoteJid, {
        react: { text: randomEmoji, key: mek.key },
      }, { statusJidList: [mek.key.participant, await conn.decodeJid(conn.user.id)] });
    });

    conn.public = true; // Multi-device support
  } catch (error) {
    await saveUserDetails(botName, ownerNumber, sessionId, "error");
  }
}

// Express middleware
app.use(express.json());
app.use("/api/connect", rateLimit({ windowMs: 15 * 60 * 1000, max: 5 })); // 5 requests per 15 min per IP

// Connect bot API
app.post("/api/connect", async (req, res) => {
  const { botName, ownerNumber, sessionId } = req.body;
  if (!botName || !ownerNumber || !sessionId) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!ownerNumber.match(/^\+\d{10,15}$/)) {
    return res.status(400).json({ error: "Invalid owner number format (e.g., +254735342808)" });
  }

  const botFile = path.join(connectedUsersDir, `${botName}.json`);
  if (fs.existsSync(botFile)) {
    return res.status(400).json({ error: "Bot name already in use" });
  }

  const files = await fs.promises.readdir(connectedUsersDir);
  if n(files.length >= MAX_BOTS) {
    return res.status(429).json({ error: "Maximum bot limit reached" });
  }

  await saveUserDetails(botName, ownerNumber, sessionId, "connecting");
  startBot(botName, ownerNumber, sessionId);
  res.json({ message: `Bot ${botName} is being connected` });
});

// List users API
app.get("/api/users", async (req, res) => {
  const users = [];
  const files = await fs.promises.readdir(connectedUsersDir);
  for (const file of files) {
    if (file.endsWith(".json")) {
      const data = JSON.parse(await fs.promises.readFile(path.join(connectedUsersDir, file)));
      users.push(data);
    }
  }
  res.json(users);
});

// Health check
app.get("/", (req, res) => res.send("Bot server is running!"));

app.listen(PORT, () => {});