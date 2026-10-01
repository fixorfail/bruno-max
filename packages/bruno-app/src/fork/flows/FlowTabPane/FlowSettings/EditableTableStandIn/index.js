import React from 'react';

/**
 * The stand-in for upstream's `EditableTable` in the specs of the settings tables. Upstream's table
 * virtualises its rows, and jsdom cannot do the layout. This one shows all rows and all columns. It
 * uses the `render` of a column if the column has one, and otherwise an input labelled with the
 * column key. The `add` button adds a row with the table's `defaultRow`.
 */
const EditableTableStandIn = ({ rows, columns, onChange, testId, defaultRow }) => (
  <table data-testid={testId}>
    <tbody>
      {rows.map((row) => {
        const change = (key) => (value) => onChange(rows.map((entry) => (entry === row ? { ...entry, [key]: value } : entry)));
        return (
          <tr key={row.uid}>
            {columns.map((column) => (
              <td key={column.key}>
                {column.render ? (
                  column.render({ row, value: row[column.key], onChange: change(column.key) })
                ) : (
                  <input aria-label={column.key} value={row[column.key]} onChange={(event) => change(column.key)(event.target.value)} />
                )}
              </td>
            ))}
          </tr>
        );
      })}
      <tr>
        <td>
          <button type="button" onClick={() => onChange([...rows, { uid: `added-${rows.length}`, ...defaultRow }])}>
            add
          </button>
        </td>
      </tr>
    </tbody>
  </table>
);

export default EditableTableStandIn;
