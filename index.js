import express from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import { startBot, stopBot } from "./bot.js";
import { saveUserDetails, getAllUsers, deleteUser, deleteAllUsers, cleanupOldBots } from "./utils.js";

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BOTS = 50;
const ADMIN_PASSWORD = "toxicadmin2025";

// Enable proxy for Heroku
app.set("trust proxy", 1);

// Enable CORS
app.use(cors({ origin: "*" })); // Restrict to Netlify domain in production

// Middleware
app.use(express.json());
app.use(
  "/api/connect",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false })
);

// Admin auth middleware
const adminAuth = (req, res, next) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid admin password" });
  }
  next();
};

// Start cleanup task (hourly)
setInterval(() => cleanupOldBots().catch((err) => console.error("Cleanup failed:", err)), 60 * 60 * 1000);

// APIs
app.post("/api/connect", async (req, res) => {
  const { botName, ownerNumber, sessionId } = req.body;
  if (!botName || !ownerNumber || !sessionId) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!ownerNumber.match(/^\+\d{10,15}$/)) {
    return res.status(400).json({ error: "Invalid owner number format (e.g., +254735342808)" });
  }
  // Validate sessionId
  try {
    const credsBuffer = Buffer.from(sessionId, "base64");
    const credsJson = credsBuffer.toString();
    const creds = JSON.parse(credsJson);
    if (!creds.me?.id || !creds.deviceId) {
      return res.status(400).json({ error: "Invalid session ID: missing required fields (me.id, deviceId)" });
    }
  } catch (error) {
    return res.status(400).json({ error: "Invalid session ID: must be valid Base64-encoded JSON" });
  }

  try {
    const users = await getAllUsers();
    if (users.find((u) => u.botName === botName)) {
      return res.status(400).json({ error: "Bot name already in use" });
    }
    if (users.length >= MAX_BOTS) {
      return res.status(429).json({ error: "Maximum bot limit reached" });
    }

    await saveUserDetails(botName, ownerNumber, sessionId, "connecting");
    await startBot(botName, ownerNumber, sessionId);
    res.json({ message: `Bot ${botName} is being connected`, botName });
  } catch (error) {
    await deleteUser(botName);
    res.status(500).json({ error: `Failed to start bot: ${error.message}` });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.post("/api/admin/delete", adminAuth, async (req, res) => {
  const { botName } = req.body;
  if (!botName) {
    return res.status(400).json({ error: "Bot name required" });
  }
  try {
    await stopBot(botName);
    await deleteUser(botName);
    res.json({ message: `Bot ${botName} deleted` });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete bot" });
  }
});

app.post("/api/admin/delete-all", adminAuth, async (req, res) => {
  try {
    const users = await getAllUsers();
    for (const user of users) {
      await stopBot(user.botName);
      await deleteUser(user.botName);
    }
    res.json({ message: "All bots deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete all bots" });
  }
});

app.get("/", (req, res) => res.send("Toxic Bot Hosting server is running!"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));