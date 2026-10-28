import type { Callback, Context } from 'aws-lambda';

export type DomainHandler = (event: any, context: Context, callback: Callback) => any;
export type DomainRouteMap = Readonly<Record<string, DomainHandler>>;

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

export function createDomainApiHandler(routes: DomainRouteMap) {
  return async (event: any, context: Context, callback: Callback) => {
    const routeKey = typeof event?.routeKey === 'string' ? event.routeKey.toUpperCase() : '';
    const handler = routes[routeKey];
    if (!handler) {
      console.warn('Rota não registrada no handler de domínio', { routeKey });
      return jsonResponse(404, { message: 'Rota não encontrada' });
    }
    return handler(event, context, callback);
  };
}
