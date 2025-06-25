import express from "express";
import rateLimit from "express-rate-limit";
import pg from "pg";
import cors from "cors";
import { startBot, stopBot } from "./bot.js";
import { saveUserDetails, getAllUsers, deleteUser, deleteAllUsers, cleanupOldBots } from "./utils.js";

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BOTS = 50;

// Enable proxy for Heroku
app.set("trust proxy", 1);

// Enable CORS
app.use(cors({ origin: "*" })); // Allow all origins for testing; restrict to Netlify domain in production

// Find Postgres URL dynamically
const postgresKey = Object.keys(process.env).find(
  (key) => key.startsWith("HEROKU_POSTGRESQL_") && key.endsWith("_URL")
);
const postgresUrl = process.env.DATABASE_URL || (postgresKey ? process.env[postgresKey] : null);
if (!postgresUrl) {
  console.error("No PostgreSQL URL found in environment variables!");
  process.exit(1);
}

// Postgres client
const pool = new pg.Pool({
  connectionString: postgresUrl,
  ssl: postgresUrl.includes("localhost") ? {} : { rejectUnauthorized: false },
});

// Middleware
app.use(express.json());
app.use(
  "/api/connect",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false })
);

// Initialize PostgreSQL tables
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        botName TEXT PRIMARY KEY,
        ownerNumber TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        status TEXT NOT NULL,
        connectedAt TIMESTAMP NOT NULL
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        botName TEXT PRIMARY KEY,
        creds JSONB NOT NULL
      );
    `);
    console.log("PostgreSQL initialized successfully");
  } catch (error) {
    console.error("Database initialization failed:", error.message);
    throw error;
  }
}
initDb().catch((err) => console.error("Database init failed:", err));

// Start cleanup task (hourly)
setInterval(() => cleanupOldBots(pool).catch((err) => console.error("Cleanup failed:", err)), 60 * 60 * 1000);

// APIs
app.post("/api/connect", async (req, res) => {
  const { botName, ownerNumber, sessionId } = req.body;
  if (!botName || !ownerNumber || !sessionId) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!ownerNumber.match(/^\+\d{10,15}$/)) {
    return res.status(400).json({ error: "Invalid owner number format (e.g., +254735342808)" });
  }

  try {
    const existing = await pool.query("SELECT botName FROM users WHERE botName = $1", [botName]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Bot name already in use" });
    }

    const users = await getAllUsers(pool);
    if (users.length >= MAX_BOTS) {
      return res.status(429).json({ error: "Maximum bot limit reached" });
    }

    await saveUserDetails(pool, botName, ownerNumber, sessionId, "connecting");
    await startBot(pool, botName, ownerNumber, sessionId);
    res.json({ message: `Bot ${botName} is being connected` });
  } catch (error) {
    await deleteUser(pool, botName);
    res.status(500).json({ error: `Failed to start bot: ${error.message}` });
  }
});

app.get("/api/users", async (req, res) => {
  try {
    const users = await getAllUsers(pool);
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

app.post("/api/delete", async (req, res) => {
  const { botName } = req.body;
  if (!botName) {
    return res.status(400).json({ error: "Bot name required" });
  }
  try {
    await stopBot(botName);
    await deleteUser(pool, botName);
    res.json({ message: `Bot ${botName} deleted` });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete bot" });
  }
});

app.post("/api/delete-all", async (req, res) => {
  try {
    const users = await getAllUsers(pool);
    for (const user of users) {
      await stopBot(user.botName);
      await deleteUser(pool, user.botName);
    }
    res.json({ message: "All bots deleted" });
  } catch (error) {
    res.status(500).json({ error: "Failed to delete all bots" });
  }
});

app.get("/", (req, res) => res.send("Toxic Bot Hosting server is running!"));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));