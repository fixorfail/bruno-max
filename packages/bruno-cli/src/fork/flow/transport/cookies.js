/**
 * 001 §7.6's session state, host side.
 *
 * The engine decides *which* jar a request uses — one per run, one per dataset iteration, and a
 * sub-flow inherits its caller's — and mints an id for it. All this does is give each id a jar of
 * its own and put the cookie mechanics of `bru run` behind it, which is the division §7.6 draws:
 * were the scoping left here, the CLI and the app could disagree about whether iteration two is a
 * fresh session.
 */
/**
 * The same implementation `bru run` stores its cookies in — `@usebruno/requests` keeps one
 * process-wide jar of it, and the engine's per-iteration isolation is why a flow cannot use that
 * one.
 */
const { CookieJar } = require('tough-cookie');

const createJars = () => {
  const jars = new Map();
  return (id) => {
    if (!jars.has(id)) jars.set(id, new CookieJar());
    return jars.get(id);
  };
};

const parseCookieHeader = (value) =>
  String(value || '')
    .split(';')
    .reduce((parsed, cookie) => {
      const [name, ...rest] = cookie.split('=');
      if (name && name.trim()) parsed[name.trim()] = rest.join('=').trim();
      return parsed;
    }, {});

/** A step may declare a `Cookie` header of its own; the jar's value wins, as it does in `bru run`. */
const mergeCookieHeader = (declared, fromJar) =>
  Object.entries({ ...parseCookieHeader(declared), ...parseCookieHeader(fromJar) })
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

const storeSetCookies = (jar, url, headers) => {
  const setCookie = headers?.['set-cookie'];
  if (!setCookie) return;
  for (const header of Array.isArray(setCookie) ? setCookie : [setCookie]) {
    if (typeof header === 'string' && header.length) jar.setCookieSync(header, url, { ignoreError: true });
  }
};

/**
 * Registered as interceptors rather than done around the call, so a leg the transport did not
 * dispatch itself — a digest or NTLM challenge being answered (§6.4) — carries and collects cookies
 * like the first one.
 */
const applyJar = (instance, jar) => {
  instance.interceptors.request.use((config) => {
    const fromJar = jar.getCookieStringSync(config.url);
    if (!fromJar) return config;

    const name = Object.keys(config.headers).find((header) => header.toLowerCase() === 'cookie');
    config.headers[name || 'Cookie'] = mergeCookieHeader(name ? config.headers[name] : '', fromJar);
    return config;
  });

  instance.interceptors.response.use(
    (response) => {
      storeSetCookies(jar, response.config.url, response.headers);
      return response;
    },
    (error) => {
      // A 401 challenge and a failing status both set cookies; only a request that never got a
      // response has none to store.
      if (error.response) storeSetCookies(jar, error.config.url, error.response.headers);
      return Promise.reject(error);
    }
  );
};

module.exports = { createJars, applyJar };
