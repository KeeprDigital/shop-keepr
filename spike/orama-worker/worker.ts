// Spike harness only; the tests drive everything.
export default { async fetch(): Promise<Response> { return new Response('spike'); } };
