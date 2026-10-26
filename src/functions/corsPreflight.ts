import { APIGatewayProxyResult } from 'aws-lambda';

/**
 * Public integration used exclusively by explicit HTTP API OPTIONS routes.
 * API Gateway applies the configured origin allowlist and CORS response headers.
 * All application methods remain protected by their Cognito authorizer.
 */
export const corsPreflight = async (): Promise<APIGatewayProxyResult> => ({
  statusCode: 204,
  headers: {
    'Cache-Control': 'public, max-age=3600'
  },
  body: ''
});
