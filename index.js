import express from "express";
import rateLimit from "express-rate-limit";
import { startBot, stopBot } from "./bot.js";
import { saveUserDetails, getAllUsers, deleteUser, deleteAllUsers, cleanupOldBots } from "./utils.js";
import pg from "pg";

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BOTS = 50;

// Postgres client
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Middleware
app.use(express.json());
app.use("/api/connect", rateLimit({ windowMs: 15 * 60 * 1000, max: 5 })); // 5 requests/15 min/IP

// Initialize Postgres table
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      botName TEXT PRIMARY KEY,
      ownerNumber TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      status TEXT NOT NULL,
      connectedAt TIMESTAMP NOT NULL
    );
  `);
}
initDb();

// Start cleanup task (every hour)
setInterval(() => cleanupOldBots(pool), 60 * 60 * 1000);

// APIs
app.post("/api/connect", async (req, res) => {
  const { botName, ownerNumber, sessionId } = req.body;
  if (!botName || !ownerNumber || !sessionId) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!ownerNumber.match(/^\+\d{10,15}$/)) {
    return res.status(400).json({ error: "Invalid owner number format (e.g., +254735342808)" });
  }

  const existing = await pool.query("SELECT botName FROM users WHERE botName = $1", [botName]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: "Bot name already in use" });
  }

  const users = await getAllUsers(pool);
  if (users.length >= MAX_BOTS) {
    return res.status(429).json({ error: "Maximum bot limit reached" });
  }

  await saveUserDetails(pool, botName, ownerNumber, sessionId, "connecting");
  try {
    await startBot(botName, ownerNumber, sessionId);
    res.json({ message: `Bot ${botName} is being connected` });
  } catch (error) {
    await deleteUser(pool, botName);
    res.status(500).json({ error: "Failed to start bot" });
  }
});

app.get("/api/users", async (req, res) => {
  const users = await getAllUsers(pool);
  res.json(users);
});

app.post("/api/delete", async (req, res) => {
  const { botName } = req.body;
  if (!botName) {
    return res.status(400).json({ error: "Bot name required" });
  }
  await stopBot(botName);
  await deleteUser(pool, botName);
  res.json({ message: `Bot ${botName} deleted` });
});

app.post("/api/delete-all", async (req, res) => {
  const users = await getAllUsers(pool);
  for (const user of users) {
    await stopBot(user.botName);
    await deleteUser(pool, user.botName);
  }
  res.json({ message: "All bots deleted" });
});

app.get("/", (req, res) => res.send("Toxic Bot Hosting server is running!"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));