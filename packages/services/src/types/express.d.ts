declare module 'express' {
  export function Router(): {
    get: (
      path: string,
      ...handlers: Array<(req: Request, res: Response, next: () => void) => void>
    ) => void;
    post: (
      path: string,
      ...handlers: Array<(req: Request, res: Response, next: () => void) => void>
    ) => void;
    put: (
      path: string,
      ...handlers: Array<(req: Request, res: Response, next: () => void) => void>
    ) => void;
    delete: (
      path: string,
      ...handlers: Array<(req: Request, res: Response, next: () => void) => void>
    ) => void;
    use: (
      path: string | (() => void),
      ...handlers: Array<(req: Request, res: Response, next: () => void) => void>
    ) => void;
  };
  export interface Request {
    body?: Record<string, unknown>;
    params: Record<string, string>;
    query: Record<string, string | string[]>;
    headers: Record<string, string>;
    user?: Record<string, unknown>;
    [key: string]: unknown;
  }
  export interface Response {
    status: (code: number) => Response;
    json: (data: unknown) => Response;
    send: (data: unknown) => Response;
    redirect: (url: string) => Response;
    [key: string]: unknown;
  }
}
