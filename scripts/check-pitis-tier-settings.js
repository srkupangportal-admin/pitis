const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pitis-tier-settings-"));
process.env.DB_PATH = path.join(testDirectory, "data.db");

const { db, initializeDatabase } = require("../src/db/init");
const {
  getPitisTier,
  getPitisTierSettings,
  setPitisTierSettings
} = require("../src/services/portalSettingsService");

try {
  initializeDatabase();
  assert.deepEqual(getPitisTierSettings(), {
    risingMin: 80,
    bronzeMin: 160,
    silverMin: 240,
    goldMin: 320
  });

  const custom = setPitisTierSettings({
    risingMin: 50,
    bronzeMin: 100,
    silverMin: 200,
    goldMin: 300
  });
  assert.equal(getPitisTier(49, custom).key, "starter");
  assert.equal(getPitisTier(50, custom).key, "rising");
  assert.equal(getPitisTier(100, custom).key, "bronze");
  assert.equal(getPitisTier(200, custom).key, "silver");
  assert.equal(getPitisTier(300, custom).key, "gold");
  assert.deepEqual(getPitisTierSettings(), custom);

  assert.throws(() => setPitisTierSettings({
    risingMin: 100,
    bronzeMin: 90,
    silverMin: 200,
    goldMin: 300
  }), /must increase/);

  console.log("PITIS tier settings check passed.");
} finally {
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
}
