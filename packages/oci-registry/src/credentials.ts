/**
 * Hosts an anonymous manifest request is allowed against.
 *
 * A table rather than a heuristic, because the consequence of guessing wrong
 * runs one way: contacting an unlisted host without a credential leaks the
 * repository name of a private image to whoever answers, and buys nothing —
 * the 401 that comes back is indistinguishable from the one a real
 * credential failure produces. Everything off this list with no credential
 * resolves to `'needs-login'` instead, which is the only outcome a caller
 * can turn into an actionable "log in to X" prompt.
 */
const PUBLIC_REGISTRIES = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
  'ghcr.io',
  'quay.io',
  'mcr.microsoft.com',
  'public.ecr.aws',
  'registry.k8s.io',
  'gcr.io',
  'k8s.gcr.io',
]);

const DOCKER_HUB_HOST = 'docker.io';

// The three spellings Docker Hub answers to. `docker login` writes the
// config entry under `https://index.docker.io/v1/`, a repository names the
// registry as `docker.io`, and the pull endpoint is `registry-1.docker.io`,
// so a credential written by one of them has to be found by the others.
const DOCKER_HUB_ALIASES = new Set([DOCKER_HUB_HOST, 'index.docker.io', 'registry-1.docker.io']);

// The key `docker login` writes Docker Hub under, and therefore the server
// URL a credential helper expects to be asked about for Docker Hub. The
// bare host would be a cache miss in every helper a real developer has.
const DOCKER_HUB_SERVER_URL = 'https://index.docker.io/v1/';

const SCHEME_PREFIX_PATTERN = /^https?:\/\//;

// Splits a decoded `auth` field on its FIRST colon: a registry password may
// contain colons, a username may not, so anything after the first one is
// password material and splitting on the last (or on every) colon silently
// truncates a legitimate secret.
const BASIC_AUTH_PATTERN = /^([^:]*):([\s\S]*)$/;

// Docker's convention for "the Secret field is an identity token, not a
// password". A helper reports it in the username slot because the protocol
// has nowhere else to put the distinction.
const IDENTITY_TOKEN_USERNAME = '<token>';

/**
 * A credential resolved for one registry.
 *
 * Two arms rather than one username/password pair, because the two are spent
 * in completely different requests: a basic credential goes out as an
 * `authorization` header, while an identity token is exchanged in a `POST`
 * body for an access token and must never travel as a password. A single
 * shape carrying a magic username is exactly how a client ends up sending a
 * refresh token where a password belongs.
 */
type RegistryCredential =
  | { readonly kind: 'basic'; readonly username: string; readonly password: string }
  | { readonly kind: 'identity-token'; readonly refreshToken: string };

/** The local Docker credential environment, injected so this package never reads disk or spawns a process itself. */
interface CredentialEnvironment {
  /** Raw contents of `~/.docker/config.json`, or `undefined` when there is none. */
  readonly readDockerConfig: () => Promise<string | undefined>;
  /** Runs `docker-credential-<helper> get` with `serverUrl` on stdin; resolves to stdout. */
  readonly runCredentialHelper: (helper: string, serverUrl: string) => Promise<string>;
}

/**
 * One entry of a Docker config table, kept alongside the key exactly as it
 * was written.
 *
 * The raw key survives normalization because it is what a credential helper
 * has to be handed back: helpers key their store by the literal string
 * `docker login` gave them, so asking one about a normalized `docker.io`
 * when the config says `https://index.docker.io/v1/` reliably misses.
 */
interface DockerConfigEntry<TValue> {
  readonly key: string;
  readonly value: TValue;
}

interface DockerAuthEntry {
  readonly identitytoken: string | undefined;
  readonly auth: string | undefined;
  readonly username: string | undefined;
  readonly password: string | undefined;
}

interface DockerConfig {
  readonly credHelpers: readonly DockerConfigEntry<string>[];
  readonly credsStore: string | undefined;
  readonly auths: readonly DockerConfigEntry<DockerAuthEntry>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readStringField(source: unknown, field: string): string | undefined {
  if (!isRecord(source)) {
    return undefined;
  }

  const value = source[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reduces a config key or a registry host to the bare `host[:port]` the two
 * can be compared on.
 *
 * Docker config keys are written inconsistently — `private.example.com`,
 * `https://private.example.com`, `https://index.docker.io/v1/` all name a
 * registry — because different Docker versions and different login flows
 * wrote them. Comparing the raw strings would make a credential the user
 * demonstrably has look absent, so both sides are reduced to the same shape
 * before they meet.
 */
function normalizeConfigKey(key: string): string {
  const [hostPort = ''] = key.replace(SCHEME_PREFIX_PATTERN, '').split('/');
  return DOCKER_HUB_ALIASES.has(hostPort) ? DOCKER_HUB_HOST : hostPort;
}

function parseAuthEntry(value: unknown): DockerAuthEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    identitytoken: readStringField(value, 'identitytoken'),
    auth: readStringField(value, 'auth'),
    username: readStringField(value, 'username'),
    password: readStringField(value, 'password'),
  };
}

function parseStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseTable<TValue>(source: unknown, field: string, parseValue: (value: unknown) => TValue | undefined): DockerConfigEntry<TValue>[] {
  const table = isRecord(source) ? source[field] : undefined;

  if (!isRecord(table)) {
    return [];
  }

  const entries: DockerConfigEntry<TValue>[] = [];

  for (const [key, rawValue] of Object.entries(table)) {
    const value = parseValue(rawValue);

    if (value !== undefined) {
      entries.push({ key, value });
    }
  }

  return entries;
}

/**
 * Parses `config.json` into the three tables that matter, treating anything
 * unparseable or unexpectedly shaped as absent.
 *
 * The config is a file on the developer's machine, edited by hand and by
 * several tools, not a value this package controls. A stray comma in it is
 * not a defect in the chart being checked, so throwing here would turn an
 * unrelated typo into an extension-host error and take the whole check down
 * with it. Every field is read through a runtime type check for the same
 * reason: nothing in the file is guaranteed to be the type it should be.
 */
function parseDockerConfig(contents: string | undefined): DockerConfig {
  let parsed: unknown;

  try {
    parsed = contents === undefined ? undefined : JSON.parse(contents);
  } catch {
    parsed = undefined;
  }

  return {
    credHelpers: parseTable(parsed, 'credHelpers', parseStringValue),
    credsStore: readStringField(parsed, 'credsStore'),
    auths: parseTable(parsed, 'auths', parseAuthEntry),
  };
}

function findEntry<TValue>(entries: readonly DockerConfigEntry<TValue>[], normalizedHost: string): DockerConfigEntry<TValue> | undefined {
  return entries.find((entry) => normalizeConfigKey(entry.key) === normalizedHost);
}

/**
 * Turns a credential helper's stdout into a credential.
 *
 * The protocol is a single JSON object, so a helper that has simply never
 * seen this registry answers with a non-zero exit or a line of prose. That
 * is the routine case on a machine whose keychain holds two logins, not a
 * failure worth surfacing, which is why every malformed shape here comes
 * back as "no credential" and lets the caller fall through to the next
 * source instead of aborting the check.
 */
function credentialFromHelperOutput(stdout: string): RegistryCredential | undefined {
  let payload: unknown;

  try {
    payload = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  const secret = readStringField(payload, 'Secret');
  const username = readStringField(payload, 'Username') ?? '';

  if (secret === undefined || secret === '') {
    return undefined;
  }

  if (username === IDENTITY_TOKEN_USERNAME) {
    return { kind: 'identity-token', refreshToken: secret };
  }

  return { kind: 'basic', username, password: secret };
}

function credentialFromBasicAuth(auth: string): RegistryCredential | undefined {
  const match = BASIC_AUTH_PATTERN.exec(Buffer.from(auth, 'base64').toString('utf8'));

  if (match === null) {
    return undefined;
  }

  const [, username = '', password = ''] = match;
  return password === '' ? undefined : { kind: 'basic', username, password };
}

/**
 * Reads a credential out of an `auths` entry, identity token first.
 *
 * The ordering is the whole point. An Azure Container Registry entry carries
 * both an `auth` field and an `identitytoken`, and that `auth` decodes to a
 * null-GUID username with an EMPTY password — it is a placeholder, not a
 * credential. A client that reads `auth` first therefore sends useless basic
 * credentials and collects a 401 from what is, for this organisation, the
 * primary registry. Checking `identitytoken` first costs nothing anywhere
 * else and makes that case work.
 */
function credentialFromAuthEntry(entry: DockerAuthEntry): RegistryCredential | undefined {
  const { identitytoken, auth, username, password } = entry;

  if (identitytoken !== undefined && identitytoken !== '') {
    return { kind: 'identity-token', refreshToken: identitytoken };
  }

  const decoded = auth === undefined ? undefined : credentialFromBasicAuth(auth);

  if (decoded !== undefined) {
    return decoded;
  }

  if (username !== undefined && password !== undefined && password !== '') {
    return { kind: 'basic', username, password };
  }

  return undefined;
}

/** The server URL to ask a helper about when no config key named this registry. */
function defaultServerUrl(normalizedHost: string): string {
  return normalizedHost === DOCKER_HUB_HOST ? DOCKER_HUB_SERVER_URL : normalizedHost;
}

interface RunHelperParams {
  readonly helper: string;
  readonly serverUrl: string;
  readonly environment: CredentialEnvironment;
}

async function runHelper(params: RunHelperParams): Promise<RegistryCredential | undefined> {
  const { helper, serverUrl, environment } = params;

  try {
    return credentialFromHelperOutput(await environment.runCredentialHelper(helper, serverUrl));
  } catch {
    return undefined;
  }
}

/**
 * Resolves the credential the local Docker setup holds for a registry, or
 * `undefined` when it holds none.
 *
 * The order — per-registry helper, then the global store, then the
 * plaintext `auths` entry — mirrors Docker's own precedence, so a developer
 * who can `docker pull` an image sees this package agree with their shell.
 * Each step falls through on a miss rather than failing, because a miss is
 * the normal state of a keychain that has only ever been asked about one
 * registry.
 *
 * This function does not throw. Every failure mode it has — no config file,
 * unparseable config, a helper that crashes — means the same thing to the
 * caller as an empty config, and the caller's job is to decide between
 * "public, try anonymously" and "ask the user to log in".
 */
async function resolveRegistryCredential(host: string, environment: CredentialEnvironment): Promise<RegistryCredential | undefined> {
  let contents: string | undefined;

  try {
    contents = await environment.readDockerConfig();
  } catch {
    contents = undefined;
  }

  const config = parseDockerConfig(contents);
  const normalizedHost = normalizeConfigKey(host);
  const helperEntry = findEntry(config.credHelpers, normalizedHost);
  const authEntry = findEntry(config.auths, normalizedHost);
  const serverUrl = helperEntry?.key ?? authEntry?.key ?? defaultServerUrl(normalizedHost);
  const helpers = new Set([helperEntry?.value, config.credsStore].filter((helper) => helper !== undefined));

  for (const helper of helpers) {
    const credential = await runHelper({ helper, serverUrl, environment });

    if (credential !== undefined) {
      return credential;
    }
  }

  return authEntry === undefined ? undefined : credentialFromAuthEntry(authEntry.value);
}

function isPublicRegistry(host: string): boolean {
  return PUBLIC_REGISTRIES.has(host);
}

export { isPublicRegistry, resolveRegistryCredential };
export type { CredentialEnvironment, RegistryCredential };
