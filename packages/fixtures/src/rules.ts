import type { SystemPackage } from '@rpg/systems';

/**
 * The fixture rules tree for feature 14 (its D-17): invented text, neither Cairn nor Fate, so the library's structural
 * assumptions stay honest. Shipped by `FIXTURE_SYSTEM_PACKAGE`; its licence allows the text because nothing here comes
 * from an external source. Quick rules and cross-references exercise FR-004 and FR-007.
 */
export const FIXTURE_RULES: SystemPackage['rules'] = {
  sections: [
    {
      id: 'introduction',
      title: 'Introduction',
      category: 'introduction',
      body: 'The Fixture System is a small invented game used to test the application. Players describe what their characters do; the game master describes the world and calls for a check when the outcome is uncertain.',
      references: ['checks'],
    },
    {
      id: 'character_creation',
      title: 'Creating a character',
      category: 'character_creation',
      body: 'Choose a name and a focus. Every character starts with 6 Focus and 10 Supplies, and writes one bond to another character.',
      references: ['checks', 'equipment'],
    },
    {
      id: 'checks',
      title: 'Checks',
      category: 'core_mechanics',
      summary: 'Roll a d10 and add the attribute that fits; 7 or more succeeds.',
      body: 'When an action is risky, the game master calls for a check. Roll one ten-sided die and add the attribute that fits the action. A total of 7 or more succeeds. A natural 1 always fails and costs 1 Focus.',
      references: ['harm', 'healing'],
    },
    {
      id: 'harm',
      title: 'Harm',
      category: 'combat',
      body: 'Each hit costs Focus equal to the damage dealt. A character at 0 Focus cannot act until healing restores at least 1 Focus.',
      references: ['healing', 'checks'],
    },
    {
      id: 'healing',
      title: 'Healing',
      category: 'recovery',
      summary: 'Rest one night and spend 1 Supplies to regain all Focus.',
      body: 'A short rest restores 1 Focus. A full night of rest restores all Focus when the character spends 1 Supplies; without supplies it restores half, rounded down.',
      references: ['harm', 'equipment'],
    },
    {
      id: 'equipment',
      title: 'Equipment and supplies',
      category: 'equipment',
      body: 'Supplies stand for food, bandages, and tools. A character carries at most 10. Resting spends them.',
      references: ['healing'],
    },
    {
      id: 'gm_procedures',
      title: 'Running the game',
      category: 'gm_procedures',
      body: 'Call for a check only when failure is interesting. Describe the harm a failure risks before the roll.',
      references: ['checks', 'harm'],
    },
  ],
};
