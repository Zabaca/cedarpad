// Regenerate the chart-authoring skill's channel table from the INSTALLED flint-chart.
//
// The table must never be hand-maintained: a channel a chart type doesn't declare is silently
// dropped by Flint (it renders a wrong chart, not an error), so a table that drifts from the
// installed version is worse than no table at all. Run this after bumping flint-chart.
//
//   bun run scripts/gen-chart-skill.ts
import { vlGetTemplateChannels, vlTemplateDefs } from 'flint-chart/vegalite';

const SKILL = new URL('../platform-skills/skills/chart-authoring/SKILL.md', import.meta.url);

const rows: string[] = [];
// vlTemplateDefs is category -> ChartTemplateDef[]; only `chart` (the type's name) is needed here.
for (const [category, defs] of Object.entries(vlTemplateDefs as unknown as Record<string, Array<{ chart: string }>>)) {
  for (const def of defs) {
    rows.push(`| ${def.chart} | ${category} | \`${vlGetTemplateChannels(def.chart).join('`, `')}\` |`);
  }
}

const table = ['| Chart type | Category | Channels |', '| --- | --- | --- |', ...rows].join('\n');
const marker = /<!-- BEGIN GENERATED -->[\s\S]*<!-- END GENERATED -->/;
const doc = await Bun.file(SKILL).text();
if (!marker.test(doc)) throw new Error(`no GENERATED block in ${SKILL.pathname}`);

await Bun.write(SKILL, doc.replace(marker, `<!-- BEGIN GENERATED -->\n${table}\n<!-- END GENERATED -->`));
console.log(`[chart-skill] ${rows.length} chart types → platform-skills/skills/chart-authoring/SKILL.md`);
