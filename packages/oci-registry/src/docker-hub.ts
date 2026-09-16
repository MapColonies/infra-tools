/**
 * The names Docker Hub answers to, in one place because no two of them are
 * interchangeable and every one of them is load-bearing somewhere.
 *
 * `docker.io` is what a repository string names. `docker login` writes the
 * credential under `https://index.docker.io/v1/`. And only
 * `registry-1.docker.io` actually serves the distribution API: a manifest
 * `GET` against `docker.io` is redirected to the marketing site, which
 * answers `200`, so a checker that trusts `response.ok` reports every Hub
 * image as existing — including tags that do not. That failure is silent
 * and it is a false positive, which is the one kind of wrong answer a
 * checkmark cannot survive.
 */

const DOCKER_HUB_HOST = 'docker.io';

/** Where Hub's distribution API actually lives. */
const DOCKER_HUB_ENDPOINT = 'registry-1.docker.io';

// The key `docker login` writes Docker Hub under, and therefore the server
// URL a credential helper expects to be asked about for Docker Hub. The
// bare host would be a cache miss in every helper a real developer has.
const DOCKER_HUB_SERVER_URL = 'https://index.docker.io/v1/';

// The namespace Hub files an official image under. `nginx` is only ever a
// spelling of `library/nginx`; the distribution API knows the long form
// alone and answers the short one with a 404 that reads exactly like a
// missing image.
const DOCKER_HUB_LIBRARY_NAMESPACE = 'library';

const DOCKER_HUB_ALIASES = new Set([DOCKER_HUB_HOST, 'index.docker.io', DOCKER_HUB_ENDPOINT]);

function isDockerHub(host: string): boolean {
  return DOCKER_HUB_ALIASES.has(host);
}

/**
 * The host that serves the distribution API for a registry named `host`.
 *
 * Only Docker Hub needs the translation. Every other registry serves its
 * own API from the host a repository names it by, and inventing an endpoint
 * for one would mean sending a credential somewhere the file never asked
 * for.
 */
function registryEndpoint(host: string): string {
  return isDockerHub(host) ? DOCKER_HUB_ENDPOINT : host;
}

export { DOCKER_HUB_HOST, DOCKER_HUB_LIBRARY_NAMESPACE, DOCKER_HUB_SERVER_URL, isDockerHub, registryEndpoint };
