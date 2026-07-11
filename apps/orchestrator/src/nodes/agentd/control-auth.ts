import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CONTEXT = 'flock-agentd-control-v2';

export function controlNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function controlCredentialId(credential: string): string {
  return createHash('sha256').update(credential).digest('hex').slice(0, 32);
}

export function validControlNonce(value: string): boolean {
  try {
    return Buffer.from(value, 'base64url').byteLength === 32;
  } catch {
    return false;
  }
}

export function controlMac(input: {
  credential: string;
  role: 'server' | 'client';
  nodeId: string;
  clientNonce: string;
  serverNonce: string;
  daemonVersion: string;
  capabilities: string[];
}): string {
  const message = [
    CONTEXT,
    input.role,
    input.nodeId,
    input.clientNonce,
    input.serverNonce,
    input.daemonVersion,
    input.capabilities.join(','),
  ].join('\0');
  return createHmac('sha256', input.credential).update(message).digest('base64url');
}

export function verifyControlMac(expected: string, presented: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
