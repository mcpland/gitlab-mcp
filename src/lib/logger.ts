import pino from "pino";

import { env } from "../config/env.js";

export const logger = pino(
  {
    name: env.MCP_SERVER_NAME,
    level: env.LOG_LEVEL,
    redact: [
      "req.headers.authorization",
      "req.headers.private-token",
      "config.GITLAB_TOKEN",
      "token"
    ]
  },
  pino.destination({ fd: 2, sync: false })
);
