import React from 'react';
import KeyValueSection from '../KeyValueSection';
import BodyField from '../BodyField';

/**
 * 005 §6.2's Request tab — what the step sends beyond what the spec seeds (001 §7): the path
 * parameters, the query, the headers, and the body. Each mapping is one table here; the body is
 * §6.7's editor. A key carrying a tag is §6.4's and is listed below the tabs rather than offered
 * here as something it is not.
 */
const SECTIONS = [
  { field: 'pathParams', label: 'Path params' },
  { field: 'query', label: 'Query' },
  { field: 'headers', label: 'Headers' }
];

const isOpaque = (step, field) => step.opaque.some((entry) => entry.key === field);

const RequestTab = ({ step, flow, content, onPatch }) => (
  <>
    {SECTIONS.map(({ field, label }) =>
      isOpaque(step, field) ? null : (
        <KeyValueSection
          key={field}
          field={field}
          label={label}
          value={step.fields[field]}
          testId={`flow-step-${field}`}
          onPatch={onPatch}
        />
      )
    )}
    {isOpaque(step, 'body') ? null : <BodyField step={step} flow={flow} content={content} onPatch={onPatch} />}
  </>
);

export default RequestTab;
