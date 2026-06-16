import Database from 'better-sqlite3';
import pkg from 'pg';
const { Pool } = pkg;

const tablesToMigrate = [
  "scraper_accounts",
  "scraper_runs",
  "worker_sessions",
  "scraper_config",
  "cards_catalog",
  "duels",
  "duel_summaries",
  "duel_games",
  "duel_player_summaries",
  "duel_seen_cards",
  "duel_play_packets",
  "duel_site_data",
  "duel_player_site_data",
  "admin_sessions",
  "archetype_groups",
  "archetype_group_cards",
  "duel_player_archetype_matches",
  "reclassification_jobs"
];

async function run() {
  const sqliteDbPath = process.argv[2] ?? ".runtime/yugitube.sqlite";
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("❌ ERROR: DATABASE_URL environment variable is missing.");
    console.error("Please run the script like this:");
    console.error("DATABASE_URL=\"postgresql://...\" npx tsx src/migrate-to-postgres.ts");
    process.exit(1);
  }

  console.log(`🔌 Connecting to SQLite: ${sqliteDbPath}`);
  const sqlite = new Database(sqliteDbPath, { readonly: true });

  console.log(`🔌 Connecting to Postgres (Neon)`);
  const pgPool = new Pool({ connectionString: databaseUrl });

  // Make sure tables are created in Postgres by triggering SiteDatabase init
  // To avoid circular dependencies here, we will just use the pool directly to copy data.
  // We assume the schema already matches since we copied it into site-database.ts

  for (const tableName of tablesToMigrate) {
    console.log(`\n⏳ Migrating table: ${tableName}...`);
    
    // Check if table exists in SQLite
    const tableExists = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
    if (!tableExists) {
      console.log(`⏭️  Skipping ${tableName} (does not exist in SQLite)`);
      continue;
    }

    // Get rows
    const rows = sqlite.prepare(`SELECT * FROM ${tableName}`).all() as any[];
    console.log(`   Found ${rows.length} rows.`);

    if (rows.length === 0) continue;

    // Get columns
    const columns = Object.keys(rows[0]);
    
    // We insert rows in chunks of 500 to avoid query limits
    const CHUNK_SIZE = 500;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      
      const values: any[] = [];
      const valueStrings: string[] = [];
      let paramCounter = 1;

      for (const row of chunk) {
        const rowValues: string[] = [];
        for (const col of columns) {
          values.push(row[col]);
          rowValues.push(`$${paramCounter++}`);
        }
        valueStrings.push(`(${rowValues.join(", ")})`);
      }

      // DO NOTHING ON CONFLICT to avoid failing if script is run twice
      // Since some tables don't have primary keys defined cleanly or have multiple,
      // it's safest to just ignore conflicts on the primary key, but Postgres requires specifying the conflict target.
      // So instead, we'll just TRUNCATE the table before inserting everything!
      if (i === 0) {
        await pgPool.query(`TRUNCATE TABLE ${tableName} CASCADE`);
      }

      const query = `
        INSERT INTO ${tableName} (${columns.join(", ")})
        VALUES ${valueStrings.join(", ")}
      `;

      await pgPool.query(query, values);
      console.log(`   Inserted chunk: ${i + chunk.length}/${rows.length}`);
    }
    console.log(`✅ Finished ${tableName}`);
  }

  console.log("\n🎉 Migration completed successfully!");
  await pgPool.end();
  sqlite.close();
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
