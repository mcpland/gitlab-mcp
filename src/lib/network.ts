import * as fs from "node:fs";

import type { Logger } from "pino";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";

import type { AppEnv } from "../config/env.js";

export function configureNetworkRuntime(env: AppEnv, logger: Logger): void {
  const rejectUnauthorized = env.NODE_TLS_REJECT_UNAUTHORIZED !== "0";
  const proxyUrl = env.HTTPS_PROXY || env.HTTP_PROXY;
  const connectOptions = {
    rejectUnauthorized,
    ca: loadCaBundle(env, logger)
  };

  if (proxyUrl) {
    const proxyDispatcher = new ProxyAgent({
      uri: proxyUrl,
      requestTls: connectOptions
    });
    setGlobalDispatcher(proxyDispatcher);
    logger.info({ proxyUrl, rejectUnauthorized }, "Configured global proxy dispatcher");
    return;
  }

  const agent = new Agent({
    connect: connectOptions
  });
  setGlobalDispatcher(agent);
  logger.info({ rejectUnauthorized }, "Configured global network agent");
}

function loadCaBundle(env: AppEnv, logger: Logger): string | undefined {
  const caPath = env.GITLAB_CA_CERT_PATH?.trim();
  if (!caPath) {
    return undefined;
  }

  try {
    return fs.readFileSync(caPath, "utf8");
  } catch (error) {
    logger.warn({ err: error, caPath }, "Failed to load GITLAB_CA_CERT_PATH");
    return undefined;
  }
}
