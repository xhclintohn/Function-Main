export async function saveUserDetails(pool, botName, ownerNumber, sessionId, status = "disconnected") {
  await pool.query(
    `INSERT INTO users (botName, ownerNumber, sessionId, status, connectedAt)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (botName) DO UPDATE
     SET ownerNumber = $2, sessionId = $3, status = $4, connectedAt = $5`,
    [botName, ownerNumber, sessionId, status, new Date().toISOString()]
  );
}

export async function getAllUsers(pool) {
  const result = await pool.query("SELECT * FROM users");
  return result.rows;
}

export async function deleteUser(pool, botName) {
  await pool.query("DELETE FROM users WHERE botName = $1", [botName]);
  await pool.query("DELETE FROM sessions WHERE botName = $1", [botName]);
}

export async function deleteAllUsers(pool) {
  const users = await getAllUsers(pool);
  for (const user of users) {
    await stopBot(user.botName);
    await deleteUser(pool, user.botName);
  }
}

export async function cleanupOldBots(pool) {
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const users = await getAllUsers(pool);
  for (const user of users) {
    if (Date.now() - new Date(user.connectedAt).getTime() > THREE_DAYS_MS) {
      await stopBot(user.botName);
      await deleteUser(pool, user.botName);
    }
  }
}