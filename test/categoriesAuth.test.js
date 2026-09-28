const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");

test("unauthenticated category reads and writes remain protected", async () => {
  const app = express();
  app.use("/api/categories", require("../routes/categories"));
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/api/categories`;
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(method === "GET" || method === "POST" ? url : `${url}/example`, { method });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { message: "Authentication required" });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
