/**
 * A `RequestBody` (001 §13.2) as axios data — 001 §7.5.
 *
 * The engine has already decided the wire format from the operation's declared media type, read
 * every file through the `ReadFile` port and resolved each part's filename and content type, so
 * nothing here re-derives any of it: this turns the tagged body it hands over into what axios sends.
 */
const FormData = require('form-data');

/**
 * §7.5's parts. `form-data` is the library `bru run` builds a multipart body with, but not through
 * `utils/form-data`'s `createFormData`: that one takes Bruno's on-disk body — file *paths* it reads
 * itself and a filename it derives from the path — and both are the engine's to decide here, down to
 * §7.5's `filename:` override.
 */
const multipartData = (parts) => {
  const form = new FormData();

  for (const part of parts) {
    if (part.kind === 'file') {
      form.append(part.name, part.file.bytes, { filename: part.file.filename, contentType: part.file.contentType });
      continue;
    }
    form.append(part.name, part.value, part.contentType ? { contentType: part.contentType } : {});
  }

  return form;
};

/**
 * Returns the data and the content type it implies. A multipart body reports no content type
 * because its own carries the boundary — `multipartHeaders` puts that on the request instead.
 */
const bodyForAxios = (body) => {
  switch (body.kind) {
    case 'none':
      return { data: undefined, contentType: undefined };
    case 'json':
      return { data: body.value, contentType: 'application/json' };
    case 'text':
      return { data: body.value, contentType: body.contentType };
    case 'urlencoded':
      return {
        data: new URLSearchParams(body.fields.map((field) => [field.name, field.value])).toString(),
        contentType: 'application/x-www-form-urlencoded'
      };
    case 'multipart':
      return { data: multipartData(body.parts), contentType: undefined };
    case 'binary':
      return { data: body.file.bytes, contentType: body.file.contentType };
    default:
      throw new Error(`the CLI does not send a ${body.kind} body for flows yet`);
  }
};

/**
 * The boundary is generated per body, so a declared `Content-Type` header that names the media type
 * without one would describe a body the server cannot parse. Keeping the declared value and adding
 * the boundary to it is what `bru run` does with a multipart request whose content type was set by
 * hand (`runner/run-single-request.js`).
 */
const multipartHeaders = (form, declared) => {
  if (!declared) return form.getHeaders();
  return declared.includes('boundary=') ? {} : { 'content-type': `${declared}; boundary=${form.getBoundary()}` };
};

const isFormData = (data) => data instanceof FormData;

module.exports = { bodyForAxios, multipartHeaders, isFormData };
