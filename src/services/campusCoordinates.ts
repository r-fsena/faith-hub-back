export function parseCampusCoordinates(latitude: unknown, longitude: unknown): { latitude: number | null; longitude: number | null } {
  const empty = (v: unknown) => v === null || v === undefined || v === '' || (typeof v === 'string' && !v.trim());
  if (empty(latitude) && empty(longitude)) return { latitude: null, longitude: null };
  const numeric = (v: unknown) => (typeof v === 'number' || typeof v === 'string') && !empty(v) && Number.isFinite(Number(v));
  if (!numeric(latitude) || !numeric(longitude) || Math.abs(Number(latitude)) > 90 || Math.abs(Number(longitude)) > 180) {
    throw new Error('Informe latitude e longitude válidas, ou deixe ambas vazias.');
  }
  return { latitude: Number(latitude), longitude: Number(longitude) };
}
