const XLSX = require('xlsx');
const path = require('path');
const db = require('../config/database');

const EXCEL_PATH = path.join(__dirname, '../../../data/EF_IC_Cuatrimestre_2026F.xlsx');

function calculateRotationSchedule(startDate, numRotations) {
  const rotations = [];
  let currentDate = new Date(startDate);

  for (let i = 0; i < numRotations; i++) {
    const sessions = [];
    let sessionDate = new Date(currentDate);

    for (let j = 0; j < 3; j++) {
      sessions.push(new Date(sessionDate));
      if (sessionDate.getDay() === 3) {
        sessionDate.setDate(sessionDate.getDate() + 3);
      } else {
        sessionDate.setDate(sessionDate.getDate() + 4);
      }
    }

    rotations.push({
      rotationNumber: i + 1,
      sessions: sessions,
      startDate: sessions[0],
      endDate: sessions[2]
    });

    currentDate = new Date(sessions[2]);
    if (currentDate.getDay() === 3) {
      currentDate.setDate(currentDate.getDate() + 3);
    } else {
      currentDate.setDate(currentDate.getDate() + 4);
    }
  }

  return rotations;
}

function excelDateToJSDate(serial) {
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400;
  const date_info = new Date(utc_value * 1000);
  return new Date(date_info.getFullYear(), date_info.getMonth(), date_info.getDate());
}

async function parseRotationData() {
  try {
    const workbook = XLSX.readFile(EXCEL_PATH);
    const rotationSheet = workbook.Sheets['Rotaciones_IC2026'];

    if (!rotationSheet) {
      throw new Error('Rotaciones_IC2026 sheet not found in Excel file');
    }

    const data = XLSX.utils.sheet_to_json(rotationSheet);
    const projects = await db.getProjects();
    const projectMap = {};

    const projectNameMappings = {
      'Producción de plantulas  y manejo de Vivero Forestal': 'Producción de plantulas y manejo de Vivero Forestal',
      'Topografía: Levantamientos planimétricos y altimétricos': 'Facilitador de Topografía: levantamientos planimétricos y altimétricos',
      'Levantamiento satelital y detección remota con Drones': 'Facilitador de procesos de levantamiento satelital y detección remota con drones',
      'Monitoreo del activo biológico forestal de la Universidad EARTH / Manejo y conservación de fauna': 'Monitoreo del activo biológico forestal de la Universidad EARTH',
      'Ensayo agroforestal Coffee EARTH/Sistema agroforestal basado en café y cacao': 'Ensayo Agroforestal y Sistema agroforestal Coffee EARTH',
      'Silvicultura de precisión': 'Silvicultura de precisión',
      'Sistema agroforestal basado en café y cacao': 'Líder de conservación y manejo de fauna'
    };

    projects.forEach(project => {
      projectMap[project.project_name.trim()] = project.id;
    });

    Object.entries(projectNameMappings).forEach(([excelName, dbName]) => {
      if (projectMap[dbName]) {
        projectMap[excelName] = projectMap[dbName];
      }
    });

    const rotations = [];
    let currentRotation = null;
    let currentRotationNumber = 0;

    for (const row of data) {
      if (row.__EMPTY && row.__EMPTY.includes('ROTACIÓN')) {
        if (currentRotation) {
          rotations.push(currentRotation);
        }

        currentRotationNumber++;

        const sessions = [];
        if (row['FECHAS (DÍAS)']) {
          sessions.push(excelDateToJSDate(row['FECHAS (DÍAS)']));
        }
        if (row.__EMPTY_1) {
          sessions.push(excelDateToJSDate(row.__EMPTY_1));
        }
        if (row.__EMPTY_2) {
          sessions.push(excelDateToJSDate(row.__EMPTY_2));
        }
        if (row.__EMPTY_3) {
          sessions.push(excelDateToJSDate(row.__EMPTY_3));
        }

        currentRotation = {
          rotationNumber: currentRotationNumber,
          sessions: sessions,
          startDate: sessions[0],
          endDate: sessions[sessions.length - 1],
          studentAssignments: []
        };
        continue;
      }

      if (currentRotation) {
        const projectColumns = [
          'Producción de plantulas  y manejo de Vivero Forestal',
          'Topografía: Levantamientos planimétricos y altimétricos',
          'Levantamiento satelital y detección remota con Drones',
          'Monitoreo del activo biológico forestal de la Universidad EARTH / Manejo y conservación de fauna',
          'Ensayo agroforestal Coffee EARTH/Sistema agroforestal basado en café y cacao',
          'Silvicultura de precisión',
          'Sistema agroforestal basado en café y cacao'
        ];

        projectColumns.forEach((projectName) => {
          const studentName = row[projectName];
          if (studentName && studentName.trim() !== '') {
            const projectId = projectMap[projectName.trim()];
            if (projectId) {
              currentRotation.studentAssignments.push({
                studentName: studentName.trim(),
                projectName: projectName.trim(),
                projectId: projectId
              });
            }
          }
        });
      }
    }

    if (currentRotation) {
      rotations.push(currentRotation);
    }

    return rotations;
  } catch (error) {
    throw error;
  }
}

async function getOrCreateStudent(studentName, projectId) {
  return new Promise((resolve, reject) => {
    db.db.get(
      'SELECT id, project_id FROM students WHERE TRIM(name) = ?',
      [studentName.trim()],
      async (err, student) => {
        if (err) {
          reject(err);
          return;
        }

        if (student) {
          if (student.project_id !== projectId) {
            await db.db.run(
              'UPDATE students SET project_id = ? WHERE id = ?',
              [projectId, student.id],
              (err) => {
                if (err) reject(err);
                else resolve(student.id);
              }
            );
          } else {
            resolve(student.id);
          }
        } else {
          db.insertStudent(studentName, null, null, projectId)
            .then(resolve)
            .catch(reject);
        }
      }
    );
  });
}

async function importRotations(startDate) {
  try {
    const rotationData = await parseRotationData();
    const schedule = calculateRotationSchedule(startDate, rotationData.length);

    for (let i = 0; i < rotationData.length; i++) {
      const rotation = rotationData[i];
      const rotationSchedule = schedule[i];

      const projectGroups = {};
      rotation.studentAssignments.forEach(assignment => {
        if (!projectGroups[assignment.projectId]) {
          projectGroups[assignment.projectId] = [];
        }
        projectGroups[assignment.projectId].push(assignment.studentName);
      });

      for (const [projectId, studentNames] of Object.entries(projectGroups)) {
        for (const studentName of studentNames) {
          const studentId = await getOrCreateStudent(studentName, parseInt(projectId));

          const startDateStr = rotationSchedule.startDate.toISOString().split('T')[0];
          const endDateStr = rotationSchedule.endDate.toISOString().split('T')[0];

          await db.insertRotation(
            rotation.rotationNumber,
            studentId,
            parseInt(projectId),
            startDateStr,
            endDateStr
          );
        }
      }
    }

    return {
      rotations: rotationData,
      schedule: schedule
    };
  } catch (error) {
    throw error;
  }
}

module.exports = {
  importRotations
};
