// Keep Node on its native runner and use Bun's native runner, including Bun 1.2.
// The suite needs only Node-style fixture cleanup, skip, and per-test timeouts.
export async function runFixture(body, timeoutMs = 5_000) {
  const cleanups = [], errors = [];
  const controller = new AbortController();
  let acceptingHooks = true, timer;
  const context = {
    signal: controller.signal,
    after(callback) {
      if (typeof callback !== "function") throw new TypeError("after requires a callback");
      if (!acceptingHooks) throw new Error("Cannot register cleanup after fixture cleanup has started");
      cleanups.push(callback);
    },
  };
  try {
    const operation = Promise.resolve().then(() => body(context));
    if (timeoutMs > 0) {
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Test timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      });
      await Promise.race([operation, timeout]);
    } else await operation;
  } catch (error) { errors.push(error); }
  finally {
    clearTimeout(timer);
    acceptingHooks = false;
    // FIFO matches the fixture ownership order used by the Node tests.
    for (const cleanup of cleanups) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    controller.abort();
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Test and fixture cleanup failed");
}

// Import the native runner in each test file before adapting it: Bun 1.2 binds
// bun:test registrations to the importing file, so a cached helper import loses tests.
export function adaptTest(nativeModule) {
  if (!process.versions.bun) return nativeModule.default;
  const nativeTest = nativeModule.test;
  return (name, options, body) => {
    if (typeof options === "function") { body = options; options = {}; }
    options ??= {};
    if (typeof body !== "function") throw new TypeError("test requires a callback");
    if (options.skip) return nativeTest.skip(name, () => {});
    const timeout = options.timeout ?? 5_000;
    // The inner deadline starts cleanup before Bun's outer deadline ends the test.
    // A timed-out body may still settle later, but its rejection stays observed.
    const runnerTimeout = timeout > 0 ? timeout + 5_000 : 2_147_483_647;
    return nativeTest(name, () => runFixture(body, timeout), runnerTimeout);
  };
}
