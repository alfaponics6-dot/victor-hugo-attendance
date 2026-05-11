#!/usr/bin/env node
/**
 * CLI wrapper for the rotation importer.
 *
 * Usage:
 *   node scripts/import-rotations.js <start-date YYYY-MM-DD>
 *
 * Reads rotation assignments from data/EF_IC_Cuatrimestre_2026F.xlsx
 * (sheet: "Rotaciones_IC2026"), generates a schedule starting on the given
 * date, and inserts rows into the rotations table. Existing students are
 * matched by name (case-trimmed); missing students are created. Run once per
 * cuatrimestre.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { importRotations } = require('../src/utils/rotationImporter');
const db = require('../src/config/database');

async function main() {
  const startDate = process.argv[2];

  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    process.stderr.write('Usage: node scripts/import-rotations.js <YYYY-MM-DD>\n');
    process.exit(1);
  }

  try {
    const result = await importRotations(startDate);
    process.stdout.write(`Imported ${result.rotations.length} rotation(s).\n`);
    for (const rotation of result.rotations) {
      const start = rotation.startDate ? rotation.startDate.toISOString().slice(0, 10) : '?';
      const end = rotation.endDate ? rotation.endDate.toISOString().slice(0, 10) : '?';
      process.stdout.write(
        `  Rotación ${rotation.rotationNumber}: ${start} → ${end} ` +
        `(${rotation.studentAssignments.length} student assignments)\n`
      );
    }
  } catch (error) {
    process.stderr.write(`Import failed: ${error.message}\n`);
    if (error.stack) process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main();
