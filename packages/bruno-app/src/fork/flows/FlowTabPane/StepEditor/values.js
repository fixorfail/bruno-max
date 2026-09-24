/**
 * How the step editor's text fields read and write a value the file may have written as something
 * other than a string (005 §6.7, §9.2): a mapping or a list shows as its JSON, and goes back as the
 * mapping while the text still parses as one — so an author who never touched the value never sees
 * it change form, and one who did gets what they typed.
 */

export const structured = (value) => value !== null && typeof value === 'object';

export const textOf = (value) => {
  if (value === undefined || value === null) return '';
  return structured(value) ? JSON.stringify(value, null, 2) : String(value);
};

/** What the typed text becomes in the document, given what the document held before. */
export const valueOf = (text, original) => {
  if (original !== undefined && structured(original)) {
    try {
      const parsed = JSON.parse(text);
      if (structured(parsed)) {
        return parsed;
      }
    } catch (error) {
      // Not a mapping any more; the text is what the author wrote.
    }
  }
  return text;
};

/** A number field's text as the document should hold it: a number, or nothing at all. */
export const numberOf = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
};
