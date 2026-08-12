/**
 * Dataset rows — 001 §9.4.
 *
 * CSV, JSON and YAML, one loader, so a flow behaves identically whichever of the three its rows
 * came from — which matters most when a dataset is converted and nothing else in the flow is
 * touched. A CSV cell is typed by §10.2's rule for a bare operand, unchanged, which is what lets
 * `when: row.canCreate eq true` compare against a boolean.
 */
import * as path from 'path';
import * as yaml from 'js-yaml';
import { evaluateJsTemplateLiteral } from '@usebruno/js/src/utils';

import type { Vars } from './types/ports';

/** Splits on commas outside quotes, and keeps the quotes: quoting is how a value stays a string. */
const splitRow = (line: string): string[] => {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (const character of line) {
    if (character === '"') {
      quoted = !quoted;
      cell += character;
    } else if (character === ',' && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
};

const parseCsv = (text: string): Vars[] => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = splitRow(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const cells = splitRow(line);
    return Object.fromEntries(
      headers.map((header, index) => [header, evaluateJsTemplateLiteral(cells[index] ?? '', {})])
    );
  });
};

export const parseDataset = (source: string, text: string): Vars[] => {
  const extension = path.extname(source).toLowerCase();
  if (extension === '.csv') return parseCsv(text);
  if (extension === '.json') return JSON.parse(text) as Vars[];
  if (extension === '.yml' || extension === '.yaml') return (yaml.load(text) || []) as Vars[];
  throw new Error(`unsupported dataset format ${extension} — CSV, JSON and YAML are supported`);
};
