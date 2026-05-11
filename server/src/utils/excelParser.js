const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');

const EXCEL_PATH = process.env.SEED_EXCEL_PATH
  ? path.resolve(__dirname, process.env.SEED_EXCEL_PATH)
  : path.join(__dirname, '../../../data/EF_IC_Cuatrimestre_2026F.xlsx');

async function parseExcelAndPopulateDB() {
  if (!fs.existsSync(EXCEL_PATH)) {
    throw new Error(`Seed spreadsheet not found at ${EXCEL_PATH}`);
  }

  const workbook = XLSX.readFile(EXCEL_PATH);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('Seed spreadsheet has no sheets');
  }
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  // First three rows are a header band.
  const dataRows = data.slice(3);
  if (dataRows.length === 0) {
    throw new Error('Seed spreadsheet has no data rows');
  }

  let projectsInserted = 0;
  let leadersInserted = 0;
  let currentProjectId = null;

  for (const row of dataRows) {
    const projectNumber = row[0];
    const projectName = row[1];
    const leaderName = row[2];

    if (typeof leaderName !== 'string' || leaderName.trim() === '') {
      continue;
    }

    if (projectNumber && projectName) {
      currentProjectId = await db.insertProject(projectNumber, projectName);
      projectsInserted++;
    }

    if (currentProjectId) {
      await db.insertLeader(leaderName.trim(), currentProjectId);
      leadersInserted++;
    }
  }

  return { projectsInserted, leadersInserted };
}

module.exports = {
  parseExcelAndPopulateDB,
  EXCEL_PATH
};
