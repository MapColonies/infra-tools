import type { RegistryCredential } from './credentials';
import { readStringField } from './read-json';
import type { FetchLike } from './fetch-like';

// Splits a `WWW-Authenticate` value into its scheme and the parameter list
// behind it. The parameters are optional because a `Basic` challenge is
// frequently the bare word, with no realm at all.
const CHALLENGE_PATTERN = /^\s*([A-Za-z]+)(?:\s+([\s\S]*))?$/;

// Only the quoted form is matched. RFC 7235 permits a bare token as a
// parameter value, but no registry emits one, and accepting unquoted values
// would mean guessing where a value ends in a header whose parameters are
// comma-separated and whose realms contain commas.
const PARAMETER_PATTERN = /([A-Za-z0-9_-]+)="([^"]*)"/g;

// Identifies this client to the token endpoint during a refresh-token
// grant. Registries log it, and Azure Container Registry requires the field
// to be present, but no registry validates it against a registration.
const CLIENT_ID = 'infra-tools';

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

// Hosts a plaintext token endpoint is tolerated on. A local registry has no
// certificate and nothing it is told leaves the machine, and `localhost` is
// already a first-class registry host in `resolve-reference`.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

type BasicCredential = Extract<RegistryCredential, { readonly kind: 'basic' }>;

/**
 * A parsed `WWW-Authenticate` challenge.
 *
 * Every field behind the scheme is optional because the registry decides
 * what it sends: Docker Hub names a realm, a service and a scope, a plain
 * `Basic` challenge names nothing at all, and a private registry may omit
 * the scope and expect the client to state the one it wants. Modelling them
 * as optional keeps that negotiation visible instead of inventing values
 * the registry never offered.
 */
interface AuthChallenge {
  readonly scheme: 'bearer' | 'basic';
  readonly realm?: string;
  readonly service?: string;
  readonly scope?: string;
}

interface AcquireBearerTokenParams {
  readonly challenge: AuthChallenge;
  readonly credential: RegistryCredential | undefined;
  readonly repositoryName: string;
  readonly fetch: FetchLike;
}

interface TokenRequestParams {
  readonly realm: URL;
  readonly challenge: AuthChallenge;
  readonly scope: string;
  readonly fetch: FetchLike;
}

interface RefreshTokenRequestParams extends TokenRequestParams {
  readonly refreshToken: string;
}

interface BasicTokenRequestParams extends TokenRequestParams {
  readonly credential: BasicCredential | undefined;
}

/**
 * Parses a `WWW-Authenticate` header into the challenge it describes.
 *
 * The scheme is compared case-insensitively because the header is defined
 * that way and registries disagree in practice — `Bearer`, `bearer` and
 * `BEARER` all occur. An unrecognised scheme returns `undefined` rather than
 * a partially-understood challenge, since guessing at a scheme this package
 * cannot satisfy would mean sending a credential in a form the registry
 * never asked for.
 */
function parseAuthenticateChallenge(header: string): AuthChallenge | undefined {
  const match = CHALLENGE_PATTERN.exec(header);

  if (match === null) {
    return undefined;
  }

  const [, rawScheme = '', rawParameters = ''] = match;
  const scheme = rawScheme.toLowerCase();

  if (scheme !== 'bearer' && scheme !== 'basic') {
    return undefined;
  }

  const parameters = new Map<string, string>();

  for (const [, key, value] of rawParameters.matchAll(PARAMETER_PATTERN)) {
    if (key !== undefined && value !== undefined) {
      parameters.set(key.toLowerCase(), value);
    }
  }

  return {
    scheme,
    realm: parameters.get('realm'),
    service: parameters.get('service'),
    scope: parameters.get('scope'),
  };
}

function basicAuthorizationHeader(credential: BasicCredential): string {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}`;
}

/**
 * Parses the realm a challenge named, refusing any plaintext endpoint off
 * the loopback interface.
 *
 * The realm is chosen by whoever answered the manifest request, and the
 * request built from it is the one carrying the credential — an `http://`
 * realm would put a password or a refresh token on the wire in the clear,
 * at the say-so of a header. Refusing it costs a verdict of
 * `'authentication-failure'`, which renders nothing, so the failure mode of
 * being strict here is silence rather than a wrong answer.
 */
function parseRealm(realm: string): URL | undefined {
  let url: URL;

  try {
    url = new URL(realm);
  } catch {
    return undefined;
  }

  return url.protocol === 'https:' || LOOPBACK_HOSTNAMES.has(url.hostname) ? url : undefined;
}

function buildTokenUrl(params: TokenRequestParams): string {
  const { realm, challenge, scope } = params;
  const url = new URL(realm.href);

  if (challenge.service !== undefined) {
    url.searchParams.set('service', challenge.service);
  }

  url.searchParams.set('scope', scope);

  return url.href;
}

/**
 * Trades an identity token for an access token via the OAuth2
 * refresh-token grant.
 *
 * An identity token is deliberately not sent as a password: it is a refresh
 * token, the endpoint that accepts it is the `POST` form-encoded grant, and
 * presenting it over basic auth gets a 401 from every registry that issues
 * one. The request carries no `authorization` header at all — the refresh
 * token in the body is the credential, and adding a header alongside it is
 * what makes Azure Container Registry reject an otherwise valid exchange.
 */
async function requestTokenWithRefreshToken(params: RefreshTokenRequestParams): Promise<string | undefined> {
  const { realm, challenge, scope, refreshToken, fetch } = params;
  const body = new URLSearchParams();

  body.set('grant_type', 'refresh_token');

  if (challenge.service !== undefined) {
    body.set('service', challenge.service);
  }

  body.set('scope', scope);
  body.set('client_id', CLIENT_ID);
  body.set('refresh_token', refreshToken);

  const response = await fetch(realm.href, {
    method: 'POST',
    headers: { 'content-type': FORM_CONTENT_TYPE },
    body: body.toString(),
  });

  if (!response.ok) {
    return undefined;
  }

  return readStringField(await response.json(), 'access_token');
}

/**
 * Asks the token endpoint for an access token, presenting a basic
 * credential when there is one and nothing when there isn't.
 *
 * The credential-free call is not a degenerate case: public registries issue
 * anonymous pull tokens from the same endpoint, so the only difference
 * between a logged-in and an anonymous pull is whether the `authorization`
 * header is present. The two response fields are both read because the
 * distribution spec names `token` and OAuth2 names `access_token`, and real
 * registries send one or the other.
 */
async function requestTokenWithBasic(params: BasicTokenRequestParams): Promise<string | undefined> {
  const { credential, fetch } = params;
  const headers: Record<string, string> = credential === undefined ? {} : { authorization: basicAuthorizationHeader(credential) };
  const response = await fetch(buildTokenUrl(params), { method: 'GET', headers });

  if (!response.ok) {
    return undefined;
  }

  const body = await response.json();
  return readStringField(body, 'token') ?? readStringField(body, 'access_token');
}

/**
 * Acquires the bearer token a `Bearer` challenge is asking for.
 *
 * The scope falls back to `repository:<name>:pull` when the challenge names
 * none, because a token issued without a scope grants nothing and the
 * retried manifest request would collect a second 401 — a registry that
 * omits the scope expects the client to name the access it wants.
 *
 * Returning `undefined` covers every way this can come up empty, and all of
 * them mean the same thing to the caller: the request cannot be
 * authenticated, which is never evidence about whether the image exists.
 */
async function acquireBearerToken(params: AcquireBearerTokenParams): Promise<string | undefined> {
  const { challenge, credential, repositoryName, fetch } = params;
  const realm = challenge.realm === undefined ? undefined : parseRealm(challenge.realm);

  if (realm === undefined) {
    return undefined;
  }

  const scope = challenge.scope ?? `repository:${repositoryName}:pull`;

  return credential?.kind === 'identity-token'
    ? requestTokenWithRefreshToken({ realm, challenge, scope, refreshToken: credential.refreshToken, fetch })
    : requestTokenWithBasic({ realm, challenge, scope, credential, fetch });
}

export { acquireBearerToken, basicAuthorizationHeader, parseAuthenticateChallenge };
