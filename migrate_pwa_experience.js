require("dotenv").config();
const crypto = require("crypto"),
  fs = require("fs");
const { createAdminConnection } = require("./scripts/db-admin.cjs");
const migrationId = "20261104_001_pwa_experience";
const checksum = crypto
  .createHash("sha256")
  .update(fs.readFileSync(__filename))
  .digest("hex");
(async () => {
  const db = await createAdminConnection();
  let locked = false;
  try {
    const [locks] = await db.query(
      "SELECT GET_LOCK('faith_hub_schema_migrations',30) AS acquired",
    );
    locked = Number(locks[0].acquired) === 1;
    if (!locked) throw Error("MIGRATION_LOCK_TIMEOUT");
    const [applied] = await db.query(
      "SELECT checksum FROM schema_migrations WHERE migration_id = ?",
      [migrationId],
    );
    if (process.argv.includes("--status")) {
      console.log(
        JSON.stringify({
          migrationId,
          applied: !!applied.length,
          checksumMatches: !applied.length || applied[0].checksum === checksum,
        }),
      );
      return;
    }
    if (applied.length) {
      if (applied[0].checksum !== checksum)
        throw Error("MIGRATION_CHECKSUM_MISMATCH");
      console.log("ALREADY_APPLIED");
      return;
    }
    await db.query(`CREATE TABLE IF NOT EXISTS pwa_experience_scopes (
 organization_id VARCHAR(100) NOT NULL,environment VARCHAR(20) NOT NULL,scope_key VARCHAR(140) NOT NULL,campus_id VARCHAR(100) NULL,
 revision INT NOT NULL DEFAULT 0,published_revision INT NOT NULL DEFAULT 0,draft_json JSON NULL,published_json JSON NULL,updated_by VARCHAR(80) NULL,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,PRIMARY KEY(organization_id,environment,scope_key)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await db.query(`CREATE TABLE IF NOT EXISTS pwa_experience_versions (
 id VARCHAR(36) PRIMARY KEY,organization_id VARCHAR(100) NOT NULL,environment VARCHAR(20) NOT NULL,scope_key VARCHAR(140) NOT NULL,campus_id VARCHAR(100) NULL,
 revision INT NOT NULL,config_json JSON NOT NULL,created_by VARCHAR(254) NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_pwa_version(organization_id,environment,scope_key,revision)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    for (const [name, type] of [
      ["theme_mode", "VARCHAR(5) NOT NULL DEFAULT 'LIGHT'"],
      ["pwa_splash_bg", "VARCHAR(7) NOT NULL DEFAULT '#0f172a'"],
    ]) {
      const [rows] = await db.query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
        ["church_settings", name],
      );
      if (!rows.length)
        await db.query(
          `ALTER TABLE church_settings ADD COLUMN ${name} ${type}`,
        );
    }
    await db.beginTransaction();
    try {
      await db.query(`INSERT INTO tenant_feature_flags(id,organization_id,campus_id,environment,feature_key,is_enabled,category,description,updated_by)
 VALUES ('ff_pwa_experience_v1','global',NULL,'all','system.saas_pwa_customization',1,'Experiência PWA','Editor de aparência, textos e publicação do PWA','pwa-experience-migration') ON DUPLICATE KEY UPDATE description=VALUES(description)`);
      await db.query(
        "INSERT INTO security_audit_logs(id,organization_id,user_email,user_role,action,resource,resource_id,details,status) VALUES(UUID(),'org_default','system@faithhubs.com','SYSTEM','PWA_EXPERIENCE_MIGRATION','schema_migrations',?,?,'SUCCESS')",
        [
          migrationId,
          JSON.stringify({ existingPublishedThemesChanged: false }),
        ],
      );
      await db.query(
        "INSERT INTO schema_migrations(migration_id,checksum) VALUES(?,?)",
        [migrationId, checksum],
      );
      await db.commit();
    } catch (e) {
      await db.rollback();
      throw e;
    }
    console.log(JSON.stringify({ migrationId, applied: true }));
  } finally {
    if (locked)
      await db.query("SELECT RELEASE_LOCK('faith_hub_schema_migrations')");
    await db.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
