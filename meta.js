// Arcane Arena metadata shared by the game host and the client.
export const meta = {
  id: 'arcane-arena',
  title: 'Arcane Arena',
  version: 'v0.3 alpha',
  options: [
    { key: 'rounds', label: 'Rounds', values: [5, 7, 11, 15] },
    { key: 'rocks', label: 'Rocks', values: [0, 1], labels: ['Off', 'On'] },
    { key: 'teams', label: 'Teams', values: [0, 2, 3, 4], labels: ['Free for all', '2', '3', '4'] },
  ],
  defaults: { rounds: 11, rocks: 0, teams: 0 },
};
