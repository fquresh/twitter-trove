// Demo X lists for the List Accounts page.
// Every handle is a fictional account from webapp/scripts/seed.ts.
// Replace this file with your own lists to use the page with real data.
export const LIST_NAMES: string[] = ['Builders', 'Researchers', 'Markets'];

export interface ListAccount {
  handle: string;
  lists: string[];
}

export const LIST_ACCOUNTS: ListAccount[] = [
  { handle: '@ada_fieldstone', lists: ['Builders', 'Researchers'] },
  { handle: '@jhalvorsen', lists: ['Researchers'] },
  { handle: '@milo_bracken', lists: ['Markets'] },
  { handle: '@tobias_quill', lists: ['Builders'] },
  { handle: '@orrin_vasquez', lists: ['Researchers'] },
  { handle: '@wren_alderbrook', lists: ['Markets', 'Builders'] },
  { handle: '@cassius_thorne', lists: ['Builders'] },
  { handle: '@imogen_falk', lists: ['Researchers'] },
  { handle: '@rafe_okonjo', lists: ['Markets'] },
  { handle: '@selma_drakewood', lists: ['Builders'] },
  { handle: '@bastian_crowe', lists: ['Researchers', 'Markets'] },
  { handle: '@nadia_vella', lists: ['Markets'] },
  { handle: '@perrin_ashgrove', lists: ['Builders'] },
  { handle: '@lio_marchetti', lists: ['Researchers'] },
  { handle: '@tamsin_reyes', lists: ['Markets'] },
  { handle: '@ezra_holloway', lists: ['Builders', 'Researchers'] },
  { handle: '@marisol_quaid', lists: ['Researchers'] },
  { handle: '@dorian_pell', lists: ['Markets'] },
  { handle: '@kasimir_lund', lists: ['Builders'] },
  { handle: '@odette_bright', lists: ['Researchers'] },
  { handle: '@fen_harrowgate', lists: ['Markets', 'Builders'] },
  { handle: '@quillfeatherlab', lists: ['Builders'] },
  { handle: '@emberline_dev', lists: ['Researchers'] },
  { handle: '@northwind_stack', lists: ['Markets'] },
  { handle: '@ferrous_lang', lists: ['Builders'] },
  { handle: '@gopherglade', lists: ['Researchers', 'Markets'] },
  { handle: '@typeforge_hq', lists: ['Markets'] },
  { handle: '@ines_carraway', lists: ['Builders'] },
  { handle: '@hollis_wexford', lists: ['Researchers'] },
  { handle: '@priya_stellmark', lists: ['Markets'] },
  { handle: '@august_vane', lists: ['Builders', 'Researchers'] },
  { handle: '@lorcan_beddoes', lists: ['Researchers'] },
  { handle: '@mira_castellan', lists: ['Markets'] },
  { handle: '@osric_penhallow', lists: ['Builders'] },
  { handle: '@paper_crane_jer', lists: ['Researchers'] },
  { handle: '@yara_whitlock', lists: ['Markets', 'Builders'] },
  { handle: '@florent_ashby', lists: ['Builders'] },
  { handle: '@kestrel_ml', lists: ['Researchers'] },
  { handle: '@riley_tamber', lists: ['Markets'] },
  { handle: '@esme_rowanberry', lists: ['Builders'] },
  { handle: '@mikael_sorrow', lists: ['Researchers', 'Markets'] },
  { handle: '@elias_greywater', lists: ['Markets'] },
  { handle: '@noor_brightman', lists: ['Builders'] },
  { handle: '@jeff_dale_ml', lists: ['Researchers'] },
  { handle: '@dmitri_halcyon', lists: ['Markets'] },
  { handle: '@lanternmind_ai', lists: ['Builders', 'Researchers'] },
  { handle: '@openhollow_ai', lists: ['Researchers'] },
  { handle: '@deepfathom_lab', lists: ['Markets'] },
  { handle: '@jack_morrow_sf', lists: ['Builders'] },
  { handle: '@nabil_quarry', lists: ['Researchers'] },
];

export const ACCOUNTS_BY_LIST: Record<string, string[]> = Object.fromEntries(
  LIST_NAMES.map((name) => [
    name,
    LIST_ACCOUNTS.filter((a) => a.lists.includes(name))
      .map((a) => a.handle)
      .sort((x, y) => x.localeCompare(y)),
  ]),
);

export function normalizeHandle(h: string): string {
  return h.replace(/^@/, '').toLowerCase();
}
