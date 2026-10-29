import type { ServerResponse } from "node:http";

// A prior async hook may yield until after close has fired. Subscribe first and
// then inspect the current state; completion and disconnect both release once.
export function onResponseEnd(raw: ServerResponse, done: () => void) {
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    raw.removeListener("close", finish);
    raw.removeListener("finish", finish);
    raw.removeListener("error", finish);
    done();
  };
  raw.once("close", finish);
  raw.once("finish", finish);
  raw.once("error", finish);
  if (raw.destroyed || raw.closed || raw.writableFinished || raw.socket?.destroyed)
    finish();
  return finish;
}
