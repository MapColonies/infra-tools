const SUCCESS_STATUS_START = 200;
const SUCCESS_STATUS_END = 300;

/** A canned fetch `Response`-shaped object for the injected fetch fake. */
function fakeFetchResponse(status: number, body: unknown = {}): { status: number; ok: boolean; json: () => Promise<unknown> } {
  return {
    status,
    ok: status >= SUCCESS_STATUS_START && status < SUCCESS_STATUS_END,
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- trivial canned response, nothing to await
    json: () => Promise.resolve(body),
  };
}

export { fakeFetchResponse };
