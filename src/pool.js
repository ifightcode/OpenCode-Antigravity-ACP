// One `agy acp` process per (binary, cwd, permission policy) for the lifetime of the server.

import { AcpClient } from "./acp.js"

const pool = new Map()

export function getClient({ binary, cwd, permissionPolicy, env, log } = {}) {
  const key = JSON.stringify([binary || process.env.AGY_ACP_BIN || "agy", cwd, permissionPolicy])
  const existing = pool.get(key)
  if (existing && !existing.dead) return existing

  const client = new AcpClient({ binary, cwd, permissionPolicy, env, log })
  pool.set(key, client)
  return client
}

export function shutdownAll() {
  for (const client of pool.values()) client.close()
  pool.clear()
}
