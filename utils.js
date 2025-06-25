import fs from "fs/promises";
import path from "path";

const BOTS_DIR = path.join(process.cwd(), "bots");

export async function saveUserDetails(botName, ownerNumber, sessionId, status) {
  try {
    const userPath = path.join(BOTS_DIR, botName, "user.json");
    await fs.mkdir(path.dirname(userPath), { recursive: true });
    const userData = {
      botName,
      ownerNumber,
      sessionId,
      status,
      connectedAt: new Date().toISOString(),
    };
    await fs.writeFile(userPath, JSON.stringify(userData, null, 2));
  } catch (error) {
    console.error(`Failed to save user details for ${botName}: ${error.message}`);
    throw error;
  }
}

export async function getAllUsers() {
  try {
    await fs.mkdir(BOTS_DIR, { recursive: true });
    const botDirs = await fs.readdir(BOTS_DIR, { withFileTypes: true });
    const users = [];
    for (const dir of botDirs) {
      if (dir.isDirectory()) {
        const userPath = path.join(BOTS_DIR, dir.name, "user.json");
        try {
          const userData = await fs.readFile(userPath, "utf8");
          users.push(JSON.parse(userData));
        } catch (error) {
          if (error.code !== "ENOENT") {
            console.error(`Failed to read user data for ${dir.name}: ${error.message}`);
          }
        }
      }
    }
    return users;
  } catch (error) {
    console.error("Failed to get all users:", error.message);
    return [];
  }
}

export async function deleteUser(botName) {
  try {
    const botDir = path.join(BOTS_DIR, botName);
    await fs.rm(botDir, { recursive: true, force: true });
  } catch (error) {
    console.error(`Failed to delete user ${botName}: ${error.message}`);
    throw error;
  }
}

export async function deleteAllUsers() {
  try {
    const users = await getAllUsers();
    for (const user of users) {
      await deleteUser(user.botName);
    }
  } catch (error) {
    console.error("Failed to delete all users:", error.message);
    throw error;
  }
}

export async function cleanupOldBots() {
  try {
    const users = await getAllUsers();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (const user of users) {
      const connectedAt = new Date(user.connectedAt);
      if (connectedAt < threeDaysAgo) {
        await deleteUser(user.botName);
        console.log(`Cleaned up old bot: ${user.botName}`);
      }
    }
  } catch (error) {
    console.error("Failed to cleanup old bots:", error.message);
  }
}