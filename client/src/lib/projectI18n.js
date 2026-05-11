// Translate a project's display name. The DB stores the Spanish canonical
// form ("Producción de plántulas..."), but the leader dropdown and admin
// tables need to localize that label per the user's selected language.
//
// We key the locale entry by `p<project_number>` (numeric keys would be
// resolvable by i18next but make the JSON harder to scan). When no
// translation exists, fall back to the raw server-side `project_name` so
// new projects added in the DB still display something sensible.
//
// Usage from a component:
//   const { t } = useTranslation('projects');
//   const label = getProjectLabel(t, { project_number, project_name });
export function getProjectLabel(t, project) {
  if (!project) return '';
  const number =
    typeof project === 'object'
      ? project.project_number ?? project.projectNumber
      : project;
  const fallback =
    (typeof project === 'object' && (project.project_name ?? project.projectName)) || '';
  if (number == null) return fallback;
  return t(`p${number}`, { defaultValue: fallback });
}
