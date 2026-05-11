const XLSX = require('xlsx');
const path = require('path');

const FILE = path.join('C:', 'Users', 'carly', 'Downloads', 'EF_IIC_Cuatrimestre_2026F Estudiantes.xlsx');

const wb = XLSX.readFile(FILE);
console.log('File:', FILE);
console.log('Sheets:', wb.SheetNames);

for (const name of wb.SheetNames) {
  const sheet = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  console.log(`\n=== Sheet: ${name} (${rows.length} rows) ===`);
  console.log('First 12 rows:');
  rows.slice(0, 12).forEach((r, i) => console.log(`  ${i}:`, JSON.stringify(r)));
  if (rows.length > 12) {
    console.log('Last 3 rows:');
    rows.slice(-3).forEach((r, i) => console.log(`  ${rows.length - 3 + i}:`, JSON.stringify(r)));
  }
}
