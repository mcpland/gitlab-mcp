import * as fs from "node:fs";

import type { Logger } from "pino";
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

import type { AppEnv } from "../config/env.js";

export function configureNetworkRuntime(env: AppEnv, logger: Logger): void {
  const rejectUnauthorized = env.NODE_TLS_REJECT_UNAUTHORIZED !== "0";
  const connectOptions = {
    rejectUnauthorized,
    ca: loadCaBundle(env, logger)
  };
  const httpProxy = env.HTTP_PROXY?.trim();
  const httpsProxy = env.HTTPS_PROXY?.trim();
  const noProxy = env.NO_PROXY?.trim();
  const hasProxy = Boolean(httpProxy || httpsProxy);

  if (hasProxy) {
    const proxyDispatcher = new EnvHttpProxyAgent({
      httpProxy,
      httpsProxy,
      noProxy,
      connect: connectOptions,
      requestTls: connectOptions
    });
    setGlobalDispatcher(proxyDispatcher);
    logger.info(
      {
        httpProxyConfigured: Boolean(httpProxy),
        httpsProxyConfigured: Boolean(httpsProxy),
        noProxyConfigured: Boolean(noProxy),
        rejectUnauthorized
      },
      "Configured global proxy dispatcher"
    );
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
