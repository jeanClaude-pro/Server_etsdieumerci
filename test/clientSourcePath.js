const path = require("node:path");

const clientRoot = process.env.JEAN_CLIENT_DIR
  ? path.resolve(process.env.JEAN_CLIENT_DIR)
  : path.resolve(__dirname, "../../jean-client");

module.exports = (...segments) => path.join(clientRoot, ...segments);
