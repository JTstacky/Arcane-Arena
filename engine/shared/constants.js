// Shared constants used by both the server simulation and the browser client.

// Warcraft III custom maps typically drove their physics ("knockback systems")
// from periodic triggers firing every 0.03s (~33 Hz). We run the authoritative
// simulation at a comparable 30 Hz and send snapshots at 15 Hz; the client
// interpolates between them.
export const TICK_RATE = 30;
export const SNAPSHOT_EVERY = 2;
export const MAX_PLAYERS = 10;

// The classic Warcraft III player colours, in slot order.
export const PLAYER_COLORS = [
  { name: 'Red', hex: '#ff0303' },
  { name: 'Blue', hex: '#0042ff' },
  { name: 'Teal', hex: '#1ce6b9' },
  { name: 'Purple', hex: '#7a17c9' },
  { name: 'Yellow', hex: '#fffc00' },
  { name: 'Orange', hex: '#fe8a0e' },
  { name: 'Green', hex: '#20c000' },
  { name: 'Pink', hex: '#e55bb0' },
  { name: 'Gray', hex: '#959697' },
  { name: 'Light Blue', hex: '#7ebff1' },
  { name: 'Dark Green', hex: '#106246' },
  { name: 'Brown', hex: '#7a4a14' },
];
