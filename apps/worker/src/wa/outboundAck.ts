export function isReachoutTimelockAck(
  update: { messageStubParameters?: unknown } | undefined,
  attrsError?: string | number
): boolean {
  if (String(attrsError ?? '') === '463') return true;
  const params = update?.messageStubParameters;
  if (!Array.isArray(params)) return false;
  return params.some((p) => String(p) === '463');
}

export function shouldBlockColdSend(opts: {
  reachoutLocked: boolean;
  isBroadcast: boolean;
  hasRecentInbound: boolean;
}): boolean {
  if (!opts.reachoutLocked) return false;
  if (opts.isBroadcast) return false;
  if (opts.hasRecentInbound) return false;
  return true;
}
