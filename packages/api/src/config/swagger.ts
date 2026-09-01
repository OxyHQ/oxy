import swaggerJsdoc from 'swagger-jsdoc';
import { version } from '../../package.json';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Oxy API',
      version: version || '1.0.0',
      description: 'API documentation for the Oxy platform',
    },
    servers: [
      {
        url: 'http://localhost:4100',
        description: 'Development server',
      },
      {
        url: 'https://api.oxy.so',
        description: 'Production server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT access token obtained from /auth/login or /auth/verify',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Machine-readable error code',
              example: 'BAD_REQUEST',
            },
            message: {
              type: 'string',
              description: 'Human-readable error message',
              example: 'Validation failed',
            },
            details: {
              type: 'object',
              description: 'Additional error details (optional)',
              additionalProperties: true,
            },
          },
          required: ['error', 'message'],
        },
      },
    },
  },
  apis: ['./src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;
