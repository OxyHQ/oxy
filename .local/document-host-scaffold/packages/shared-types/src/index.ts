/** Types shared between the frontend and backend of Document host probe. */

/** Response shape of the backend health check. */
export interface HealthResponse {
  status: 'ok';
  service: string;
}
