import pkg from 'pg';
const { Pool } = pkg;
import { IGNORED_PLAYS } from './analytics/duel-parser.js';

async function run() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
    console.error("Please run the script like this:");
    console.error("DATABASE_URL=\"postgresql://...\" npm run cleanup-packets");
    process.exit(1);
  }

  console.log(`🔌 Connecting to Postgres (Neon)`);
  const pgPool = new Pool({ connectionString: databaseUrl });

  try {
    const ignoredArray = Array.from(IGNORED_PLAYS);
    
    console.log(`⏳ Deleting irrelevant packets from duel_play_packets...`);
    console.log(`Skipping plays: ${ignoredArray.join(', ')}`);

    // Delete packets where the 'play' matches IGNORED_PLAYS, and they don't contain a chat message
    const res = await pgPool.query(`
      DELETE FROM duel_play_packets
      WHERE play = ANY($1::text[])
        AND (packet_json::json->>'message' IS NULL)
    `, [ignoredArray]);

    console.log(`✅ Successfully deleted ${res.rowCount} irrelevant packets!`);

    // Print remaining size
    const countRes = await pgPool.query(`SELECT COUNT(*) as count FROM duel_play_packets`);
    console.log(`📊 Remaining packets in database: ${countRes.rows[0].count}`);

  } catch (error) {
    console.error("❌ Failed to cleanup packets:", error);
  } finally {
    await pgPool.end();
  }
}

run();
