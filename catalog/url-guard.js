'use strict';

/**
 * url-guard.js
 * ────────────
 * BotForge – SSRF guard for catalog website imports.
 *
 * The crawler fetches URLs supplied by bot owners, so every request (and
 * every redirect hop) must be checked against loopback, private, link-local
 * and cloud-metadata addresses before connecting.
 */

const dns = require('dns');
const net = require('net');

const blockList = new net.BlockList();
blockList.addSubnet('0.0.0.0', 8, 'ipv4');
blockList.addSubnet('10.0.0.0', 8, 'ipv4');
blockList.addSubnet('127.0.0.0', 8, 'ipv4');
blockList.addSubnet('169.254.0.0', 16, 'ipv4');   // link-local, incl. cloud metadata
blockList.addSubnet('172.16.0.0', 12, 'ipv4');
blockList.addSubnet('192.168.0.0', 16, 'ipv4');
blockList.addAddress('::', 'ipv6');
blockList.addAddress('::1', 'ipv6');
blockList.addSubnet('fc00::', 7, 'ipv6');          // unique local
blockList.addSubnet('fe80::', 10, 'ipv6');         // link-local

/** '::ffff:127.0.0.1' or '::ffff:7f00:1' → '127.0.0.1'; otherwise null. */
function mappedIPv4(ip) {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  }
  return null;
}

/**
 * @param {string} ip
 * @returns {boolean} true when the address must not be fetched
 */
function isBlockedAddress(ip) {
  const mapped = mappedIPv4(ip);
  if (mapped) return blockList.check(mapped, 'ipv4');

  const family = net.isIP(ip);
  if (family === 4) return blockList.check(ip, 'ipv4');
  if (family === 6) return blockList.check(ip, 'ipv6');
  return true; // not an IP at all — refuse rather than guess
}

function guardError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Validate that a URL is http(s) and resolves only to public addresses.
 *
 * @param {string} url
 * @param {{ lookup?: Function }} opts – dns.promises.lookup-compatible (injectable for tests)
 * @returns {Promise<URL>}
 * @throws {Error} code 'URL_INVALID' | 'URL_BLOCKED'
 */
async function assertPublicUrl(url, { lookup = dns.promises.lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw guardError('URL_INVALID', 'URL is not valid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw guardError('URL_INVALID', 'Only http and https URLs can be imported.');
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw guardError('URL_BLOCKED', 'URL points to a local address.');
  }

  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw guardError('URL_INVALID', 'URL host could not be resolved.');
    }
  }

  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw guardError('URL_BLOCKED', 'URL points to a private or local address.');
  }

  return parsed;
}

module.exports = { isBlockedAddress, assertPublicUrl };
