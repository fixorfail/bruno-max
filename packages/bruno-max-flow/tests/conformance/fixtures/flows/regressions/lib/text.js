// A library file: several helpers in one place, in the language they are written in. §8.6 composes
// this source into every script the flow runs, so its declarations are simply in scope.
const lastFour = (value) => String(value).slice(-4);

const digitsOnly = (value) => String(value).replace(/[^0-9]/g, '');
