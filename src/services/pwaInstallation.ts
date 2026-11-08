import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkRateLimit } from './rateLimiter';

const APP_ORIGIN = 'https://app.faithhubs.com';
const MAX_BYTES = 5 * 1024 * 1024;
const cache = new Map<string, { expires: number; image: Buffer }>();
export class InstallationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function installOrigin(value?: string): string {
  const configured = process.env.PWA_APP_ORIGIN || APP_ORIGIN;
  const allowed = [APP_ORIGIN, 'https://pwa.faithhubs.com', 'https://main.d312p1jp7kl7kp.amplifyapp.com', configured];
  const origin = value || configured;
  if (!allowed.includes(origin) || new URL(origin).protocol !== 'https:') throw new InstallationError(400, 'Origem de instalação inválida.');
  return origin;
}
export function installationIdentity(settings: any, origin: string) {
  const organizationId = String(settings.organization_id || '');
  const slug = String(settings.pwa_slug || '');
  if (!/^[a-z0-9_-]{1,100}$/i.test(organizationId) || !/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$|^[a-z0-9]$/i.test(slug)) throw new InstallationError(422, 'Identidade de instalação incompleta.');
  const config = settings.pwa_experience?.enabled && settings.pwa_experience?.customized ? settings.pwa_experience.config : null;
  const clean = (v: unknown, max: number) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  const name = clean(config?.identity?.name || settings.church_name, 180);
  if (!name) throw new InstallationError(422, 'Nome da igreja indisponível.');
  const short = clean(settings.pwa_short_name, 32);
  const shortName = short && !['Minha Igreja', 'Faith App'].includes(short) ? short : name.slice(0, 24);
  const logo = String(config?.identity?.logo_url || settings.logo_icon_url || `${APP_ORIGIN}/brand/logo-symbol.png`);
  const version = createHash('sha256').update(organizationId + ':' + logo).digest('hex').slice(0, 16);
  const color = (v: unknown, fallback: string) => typeof v === 'string' && /^#[a-f0-9]{6}$/i.test(v) ? v : fallback;
  return { organizationId, slug, name, shortName, logo, version, origin,
    id: `${origin}/pwa-installations/${encodeURIComponent(organizationId)}`,
    startUrl: `${origin}/${encodeURIComponent(slug)}/`,
    themeColor: color(config?.theme?.light?.header || settings.pwa_theme_color, '#ffffff'),
    backgroundColor: color(config?.theme?.light?.background || settings.pwa_splash_bg, '#ffffff') };
}
export function installationManifest(settings: any, origin: string, endpoint: string) {
  const info = installationIdentity(settings, origin);
  const icon = (size: number) => {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ organization_id: info.organizationId, format: 'pwa-icon', size: String(size), v: info.version }).toString();
    return url.href;
  };
  return { id: info.id, name: info.name, short_name: info.shortName, description: `Aplicativo oficial de ${info.name}.`,
    start_url: info.startUrl, scope: info.startUrl, display: 'standalone', orientation: 'portrait', lang: 'pt-BR',
    theme_color: info.themeColor, background_color: info.backgroundColor,
    icons: [180, 192, 512].map(size => ({ src: icon(size), sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })) };
}
export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && c === 0)))
      || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  // IPv4-mapped, local, multicast, NAT64 and transition addresses are not used for logo fetching.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2002:/i.test(address) && !/^2001:(?:0{1,4}:|:|db8:|0?10:|0?20:)/i.test(address);
}
export async function readPublicLogo(value: string, redirects = 0): Promise<Buffer> {
  if (/^data:image\/(png|jpeg|webp|gif);base64,/i.test(value)) {
    if (value.length > MAX_BYTES * 1.4) throw new InstallationError(422, 'Logo muito grande.');
    return Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  }
  if (value.length > 2000) throw new InstallationError(422, 'URL do logo inválida.');
  let url: URL;
  try { url = new URL(value); } catch { throw new InstallationError(422, 'URL do logo inválida.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || redirects > 2) throw new InstallationError(422, 'URL do logo inválida.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => !isPublicImageAddress(item.address))) throw new InstallationError(422, 'Endereço do logo não permitido.');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' },
      // Pin the validated DNS answer: a second lookup cannot redirect us to a private network.
      lookup: ((_hostname: string, _options: any, callback: any) => _options?.all ? callback(null, [{ address: selected.address, family: selected.family }]) : callback(null, selected.address, selected.family)) as any,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        res.resume(); void readPublicLogo(new URL(res.headers.location, url).href, redirects + 1).then(resolve, reject); return;
      }
      if (res.statusCode !== 200 || Number(res.headers['content-length'] || 0) > MAX_BYTES) { res.resume(); reject(new InstallationError(422, 'Não foi possível carregar o logo.')); return; }
      let bytes = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BYTES) req.destroy(new InstallationError(422, 'Logo muito grande.')); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new InstallationError(503, 'Tempo de leitura do logo excedido.')), 5000);
    req.once('close', () => clearTimeout(timer)); req.once('error', reject); req.end();
  });
}
export async function installationIcon(settings: any, size: number): Promise<Buffer> {
  if (![180, 192, 512].includes(size)) throw new InstallationError(400, 'Tamanho de ícone inválido.');
  const info = installationIdentity(settings, APP_ORIGIN), key = `${info.organizationId}:${info.version}:${size}`;
  const hit = cache.get(key); if (hit && hit.expires > Date.now()) return hit.image;
  const data = await readPublicLogo(info.logo);
  // Only raster logos accepted by the branding upload flow; no SVG external resources.
  const raster = data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString()) || (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP');
  if (!raster) throw new InstallationError(422, 'Use um logo PNG, JPEG, WebP ou GIF.');
  const sharp = (await import('sharp')).default;
  const image = await sharp(data, { limitInputPixels: 16_000_000, animated: false }).rotate()
    .resize(size, size, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).png().toBuffer();
  for (const [id, entry] of cache) if (entry.expires <= Date.now()) cache.delete(id);
  while (cache.size >= 24 || [...cache.values()].reduce((total, entry) => total + entry.image.length, 0) + image.length > 8 * 1024 * 1024) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 3600000, image }); return image;
}
export async function pwaInstallationResponse(event: APIGatewayProxyEvent, settings: any): Promise<APIGatewayProxyResult> {
  const rate = await checkRateLimit(event, { maxRequests: 100, windowSeconds: 60, identifierPrefix: 'pwa_installation' });
  if (!rate.allowed) return rate.errorResponse!;
  const q = event.queryStringParameters || {};
  if (!q.organization_id && !q.slug) throw new InstallationError(400, 'Informe a igreja.');
  if (settings.status === 'INACTIVE' || !settings.organization_id) throw new InstallationError(404, 'Igreja indisponível.');
  if (q.organization_id && q.organization_id !== settings.organization_id) throw new InstallationError(400, 'Identificadores de igreja conflitantes.');
  if (q.slug && q.slug !== settings.pwa_slug && q.slug !== settings.organization_id) throw new InstallationError(400, 'Identificadores de igreja conflitantes.');
  const headers = { 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };
  if (q.format === 'pwa-icon') {
    const image = await installationIcon(settings, Number(q.size));
    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }, isBase64Encoded: true, body: image.toString('base64') };
  }
  const origin = installOrigin(q.origin);
  const domain = (event.requestContext as any)?.domainName;
  // Request context is supplied by API Gateway, not an untrusted Host header.
  const endpoint = process.env.PWA_MANIFEST_ENDPOINT || (domain ? `https://${domain}/church-settings` : 'https://usl72lj2m5.execute-api.us-east-2.amazonaws.com/church-settings');
  return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(installationManifest(settings, origin, endpoint)) };
}
