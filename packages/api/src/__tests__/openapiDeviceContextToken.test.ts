import { readFileSync } from 'node:fs';
import path from 'node:path';

it('documents the holder-proven context token request and response', () => {
  const document = JSON.parse(readFileSync(path.resolve(__dirname, '../../openapi.json'), 'utf8'));
  const operation = document.paths['/session/device/context-token-v1'].post;
  expect(operation.security).toEqual([{}]);
  const request = operation.requestBody.content['application/json'].schema;
  expect(request.required).toEqual(['deviceId', 'deviceSecret']);
  expect(request.additionalProperties).toBe(false);
  expect(Object.keys(request.properties)).toEqual(['deviceId', 'deviceSecret']);
  const response = operation.responses['200'].content['application/json'].schema;
  expect(response.required).toEqual(['data']);
  expect(response.properties.data.required).toEqual([
    'version',
    'deviceId',
    'deviceSessionId',
    'revision',
    'contextId',
    'actorId',
    'accountId',
    'sessionId',
    'accessToken',
    'expiresAt',
  ]);
  for (const status of ['400', '401', '409', '429']) {
    expect(operation.responses[status].content['application/json'].schema).toBeDefined();
  }
});

it('documents required bearer and holder evidence without returning credentials', () => {
  const document = JSON.parse(readFileSync(path.resolve(__dirname, '../../openapi.json'), 'utf8'));
  const operation = document.paths['/session/device/context-evidence-v1'].post;
  expect(operation.security).toEqual([{ bearerAuth: [] }]);
  const request = operation.requestBody.content['application/json'].schema;
  expect(request.required).toEqual(['deviceId', 'deviceSecret']);
  expect(request.additionalProperties).toBe(false);
  const evidence = operation.responses['200'].content['application/json'].schema.properties.data;
  expect(evidence.additionalProperties).toBe(false);
  expect(evidence.required).toEqual([
    'version',
    'deviceId',
    'deviceSessionId',
    'revision',
    'contextId',
    'actorId',
    'accountId',
    'sessionId',
    'expiresAt',
  ]);
  expect(evidence.properties).not.toHaveProperty('accessToken');
  expect(evidence.properties).not.toHaveProperty('deviceSecret');
  for (const status of ['400', '401', '403', '409', '429', '503']) {
    expect(operation.responses[status].content['application/json'].schema).toBeDefined();
  }
});
